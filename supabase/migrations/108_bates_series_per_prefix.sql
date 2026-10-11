-- 108_bates_series_per_prefix.sql
--
-- Bates numbering runs PER PREFIX within a matter (Eden, 2026-10-11).
--
-- Before: allocate_production_bates (071) took the next number from the
-- MATTER's high-water mark and refused any range already used anywhere in the
-- matter, whatever the prefix. A matter whose first production was
-- PTLTEST_0000001-0000004 stamped its next production, prefix PTLZIP_, from
-- PTLZIP_0000005; a new prefix could never start at 1 (it would have been
-- refused as a "collision" with a different series).
--
-- After: a series is (matter, prefix). A new prefix starts at 1; a repeated
-- prefix continues where it left off (supplemental volumes stay gapless); the
-- collision and reservation checks compare only numbers in the same series.
-- Prefixes are compared case- and edge-whitespace-insensitively
-- (_bates_series_key), so "ACME_" and " acme_" are one series and continue
-- rather than restart.
--
-- Unchanged: the registry's unique (matterspace_id, bates_number) — the full
-- label, prefix included — still makes reuse of any actual number a database
-- error; one advisory lock per matter still serialises allocation; the
-- function is otherwise byte-identical to 071's.
--
-- Also: bates_next_seq(matter, prefix), SECURITY INVOKER, for the Bates &
-- Produce panel's suggested "Start at" (RLS decides what the caller can see).
--
-- Idempotent: safe to paste twice. ORDER MATTERS: 108 replaces 071's
-- allocate_production_bates and register_bates_pages, so re-pasting 071 after
-- 108 would silently put matter-wide numbering back. If 071 is ever
-- re-pasted, paste 108 again after it.

create or replace function public._bates_series_key(p_prefix text)
returns text
language sql
immutable
as $$ select upper(btrim(coalesce(p_prefix, ''))) $$;

grant execute on function public._bates_series_key(text) to anon, authenticated, service_role;

create or replace function public.allocate_production_bates(
  p_production uuid,
  p_items      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod   public.productions%rowtype;
  v_alloc  public.production_bates_allocations%rowtype;
  v_want   jsonb;
  v_have   jsonb;
  v_spent  int;
  v_total  bigint;
  v_start  bigint;
  v_end    bigint;
  v_hw     bigint;
  v_res    bigint;
  v_clash  int;
  v_plan   jsonb := '[]'::jsonb;
  v_seq    bigint;
  v_e      jsonb;
  v_pages  int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'allocate_production_bates: p_items must be a non-empty array';
  end if;

  select * into v_prod from public.productions where id = p_production for update;
  if not found then
    raise exception 'allocate_production_bates: production % not found', p_production;
  end if;

  -- Serialise allocation per matter (still per matter, not per series: one
  -- lock is simpler and costs nothing at this volume). Two productions stamping in the same
  -- second must not reserve the same numbers, and PGlite's single connection
  -- cannot prove that — a second Fly machine can.
  perform pg_advisory_xact_lock(hashtextextended(v_prod.matterspace_id::text, 0));

  -- What the caller is asking for, reduced to the part that is identity.
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', t.e->>'item_id', 'pages', (t.e->>'pages')::int) order by t.ord), '[]'::jsonb)
    into v_want
    from jsonb_array_elements(p_items) with ordinality t(e, ord);

  select * into v_alloc from public.production_bates_allocations where production_id = p_production;
  if found then
    if coalesce(v_alloc.bates_prefix, '') is distinct from coalesce(v_prod.bates_prefix, '')
       or v_alloc.bates_pad is distinct from v_prod.bates_pad then
      raise exception
        'Bates numbers were already allocated for this production as %-%. Changing the prefix or the pad width now would split one production across two numbering schemes; create a supplemental production instead.',
        public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.start_seq),
        public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.end_seq);
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', t.e->>'item_id', 'pages', (t.e->>'pages')::int) order by t.ord), '[]'::jsonb)
      into v_have
      from jsonb_array_elements(v_alloc.item_plan) with ordinality t(e, ord);

    if v_have is distinct from v_want then
      select count(*) into v_spent from public.bates_registry where production_id = p_production;
      if v_spent > 0 then
        raise exception
          'The documents in this production changed after % Bates number(s) had already been assigned (%-%). Those numbers cannot be re-used. Finish or abandon this production and create a supplemental one.',
          v_spent,
          public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.start_seq),
          public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.end_seq);
      end if;
      -- Nothing was ever registered, so the reservation costs nothing to give
      -- back: the reviewer tagged a document between the failed attempt and
      -- this one, which is exactly what review is for.
      delete from public.production_bates_allocations where production_id = p_production;
    else
      return to_jsonb(v_alloc);
    end if;
  end if;

  select coalesce(sum((e->>'pages')::int), 0) into v_total from jsonb_array_elements(p_items) e;
  if v_total <= 0 then
    raise exception 'allocate_production_bates: the item plan totals % page(s)', v_total;
  end if;

  -- 108: the high-water mark is the SERIES's (this prefix in this matter),
  -- not the matter's. A new prefix starts at 1.
  select coalesce(max(r.bates_seq), 0) into v_hw
    from public.bates_registry r
    join public.productions p on p.id = r.production_id
   where r.matterspace_id = v_prod.matterspace_id
     and public._bates_series_key(p.bates_prefix) = public._bates_series_key(v_prod.bates_prefix);
  select coalesce(max(end_seq), 0) into v_res
    from public.production_bates_allocations
   where matterspace_id = v_prod.matterspace_id
     and public._bates_series_key(bates_prefix) = public._bates_series_key(v_prod.bates_prefix);

  v_start := coalesce(v_prod.bates_start, greatest(v_hw, v_res) + 1);
  if v_start < 1 then
    raise exception 'allocate_production_bates: a Bates start of % is not a number', v_start;
  end if;
  v_end := v_start + v_total - 1;

  select count(*) into v_clash
    from public.bates_registry r
    join public.productions p on p.id = r.production_id
   where r.matterspace_id = v_prod.matterspace_id
     and public._bates_series_key(p.bates_prefix) = public._bates_series_key(v_prod.bates_prefix)
     and r.bates_seq between v_start and v_end;
  if v_clash > 0 then
    raise exception 'Bates collision: % number(s) in %-% are already assigned in this matter',
      v_clash,
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_start),
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_end);
  end if;

  if exists (
    select 1 from public.production_bates_allocations a
     where a.matterspace_id = v_prod.matterspace_id
       and a.production_id <> p_production
       and public._bates_series_key(a.bates_prefix) = public._bates_series_key(v_prod.bates_prefix)
       and a.start_seq <= v_end and a.end_seq >= v_start
  ) then
    raise exception 'Bates reservation conflict: %-% overlaps numbers already allocated to another production in this matter',
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_start),
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_end);
  end if;

  v_seq := v_start;
  for v_e in
    select t.e from jsonb_array_elements(p_items) with ordinality t(e, ord) order by t.ord
  loop
    v_pages := (v_e->>'pages')::int;
    if v_pages is null or v_pages < 1 then
      raise exception 'allocate_production_bates: item % was pre-flighted at % page(s)',
        v_e->>'item_id', coalesce(v_pages::text, 'null');
    end if;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object(
      'item_id',     v_e->>'item_id',
      'pages',       v_pages,
      'start_seq',   v_seq,
      'end_seq',     v_seq + v_pages - 1,
      'bates_first', public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_seq),
      'bates_last',  public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_seq + v_pages - 1)));
    v_seq := v_seq + v_pages;
  end loop;

  insert into public.production_bates_allocations
    (production_id, matterspace_id, bates_prefix, bates_pad, start_seq, end_seq, total_pages, item_plan)
  values
    (p_production, v_prod.matterspace_id, v_prod.bates_prefix, v_prod.bates_pad,
     v_start, v_end, v_total, v_plan)
  returning * into v_alloc;

  -- The range is visible on the production the moment it is reserved, not
  -- only when stamping finishes. A crash between the two used to leave the
  -- production showing no range at all while its numbers were already gone.
  update public.productions
     set bates_start = v_start, bates_end = v_end
   where id = p_production;

  return to_jsonb(v_alloc);
end $$;

revoke execute on function public.allocate_production_bates(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.allocate_production_bates(uuid, jsonb) to service_role;

create or replace function public.register_bates_pages(
  p_production uuid,
  p_item       uuid,
  p_start_seq  bigint,
  p_pages      int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc   public.production_bates_allocations%rowtype;
  v_ok      boolean;
  v_ins     int := 0;
  v_foreign int;
  v_inrange int;
  v_mine    int;
  v_last    bigint;
begin
  if p_pages is null or p_pages < 1 then
    raise exception 'register_bates_pages: % page(s) is not a document', coalesce(p_pages::text, 'null');
  end if;
  v_last := p_start_seq + p_pages - 1;

  select * into v_alloc from public.production_bates_allocations where production_id = p_production;
  if not found then
    raise exception 'register_bates_pages: production % has no Bates allocation — allocate first', p_production;
  end if;

  -- The range must be exactly the one this document was allocated. A caller
  -- that has drifted from the plan is refused before it can write anything.
  select true into v_ok
    from jsonb_array_elements(v_alloc.item_plan) e
   where e->>'item_id' = p_item::text
     and (e->>'start_seq')::bigint = p_start_seq
     and (e->>'pages')::int = p_pages
   limit 1;
  if not coalesce(v_ok, false) then
    raise exception 'register_bates_pages: %-% is not the range allocated to document % in this production',
      p_start_seq, v_last, p_item;
  end if;

  insert into public.bates_registry
    (matterspace_id, bates_number, bates_seq, production_id, production_item_id, page_number)
  select v_alloc.matterspace_id,
         public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, p_start_seq + g),
         p_start_seq + g, p_production, p_item, g + 1
    from generate_series(0, p_pages - 1) g
  on conflict (matterspace_id, bates_number) do nothing;
  get diagnostics v_ins = row_count;

  -- Whatever was already there has to be OURS. ON CONFLICT DO NOTHING makes a
  -- re-run free; it must never make a genuine collision quiet.
  -- 108: only numbers in the same series (matter + prefix) can collide.
  select count(*) into v_foreign
    from public.bates_registry r
    join public.productions p on p.id = r.production_id
   where r.matterspace_id = v_alloc.matterspace_id
     and public._bates_series_key(p.bates_prefix) = public._bates_series_key(v_alloc.bates_prefix)
     and r.bates_seq between p_start_seq and v_last
     and (r.production_item_id is distinct from p_item
          or r.production_id is distinct from p_production);
  if v_foreign > 0 then
    raise exception 'Bates collision: % number(s) in %-% belong to another document; nothing was re-used',
      v_foreign,
      public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, p_start_seq),
      public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_last);
  end if;

  -- ...and there must be exactly as many of them as the document has pages.
  -- Catches the one case the ownership test cannot see: the same document
  -- registered twice under two different prefixes.
  select count(*) into v_inrange
    from public.bates_registry r
    join public.productions p on p.id = r.production_id
   where r.matterspace_id = v_alloc.matterspace_id
     and public._bates_series_key(p.bates_prefix) = public._bates_series_key(v_alloc.bates_prefix)
     and r.bates_seq between p_start_seq and v_last;
  if v_inrange <> p_pages then
    raise exception 'Bates registry holds % row(s) for the % page(s) allocated at %-%',
      v_inrange, p_pages, p_start_seq, v_last;
  end if;
  -- 071's range count also caught one document registered under two
  -- prefixes; scoped to a series it no longer can, so count the document.
  select count(*) into v_mine from public.bates_registry r where r.production_item_id = p_item;
  if v_mine <> p_pages then
    raise exception 'Bates registry holds % row(s) for document % but it has % page(s); it must not be numbered twice',
      v_mine, p_item, p_pages;
  end if;

  return jsonb_build_object(
    'inserted', v_ins, 'pages', p_pages,
    'bates_first', public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, p_start_seq),
    'bates_last',  public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_last));
end $$;

revoke execute on function public.register_bates_pages(uuid, uuid, bigint, int) from public, anon, authenticated;
grant  execute on function public.register_bates_pages(uuid, uuid, bigint, int) to service_role;

-- The next free number in a series, for the UI's suggestion. INVOKER: the
-- caller's own RLS on bates_registry / production_bates_allocations decides
-- what it can see (matter members view both).
create or replace function public.bates_next_seq(p_matter uuid, p_prefix text)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select greatest(
    coalesce((select max(r.bates_seq)
                from public.bates_registry r
                join public.productions p on p.id = r.production_id
               where r.matterspace_id = p_matter
                 and public._bates_series_key(p.bates_prefix) = public._bates_series_key(p_prefix)), 0),
    coalesce((select max(a.end_seq)
                from public.production_bates_allocations a
               where a.matterspace_id = p_matter
                 and public._bates_series_key(a.bates_prefix) = public._bates_series_key(p_prefix)), 0)
  ) + 1
$$;

grant execute on function public.bates_next_seq(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
