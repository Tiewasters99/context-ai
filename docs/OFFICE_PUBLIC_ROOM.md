# The Office: whose room is public

`GET /api/office` is the only window the public has into Contextspaces. It is
unauthenticated and runs on the **service role**, which sees every tenant's
rows regardless of RLS. So the question "whose office is this?" cannot be
answered by the request — it is answered by the server.

## The rule

One environment variable names the single owner whose office is public:

```
OFFICE_DEFAULT_OWNER_ID=<the auth.users uuid of that owner>
```

- `GET /api/office` lists **only that owner's** `office_sections`, holding
  **only that owner's** `published` `office_items`.
- `GET /api/office?book=<item id>` serves reading pages **only** for an item
  that belongs to that owner and is published. Anything else — another
  tenant's item, an unpublished item, a non-uuid, a deleted one — gets the
  same `404 No such book on the shelves`.
- `published = true` is an owner saying "show this in **my** office". It does
  not, by itself, make anything public. A second customer can publish all they
  like; nothing of theirs is listed or served until an operator deliberately
  points `OFFICE_DEFAULT_OWNER_ID` at them.

There is deliberately **no `?owner=` parameter**. Accepting an owner id from
the caller would make every tenant's published rows anonymously fetchable by
anyone who learned a uuid — which is the exposure this rule exists to close.
If a second public room is ever wanted, add a server-side allowlist
(`OFFICE_PUBLIC_OWNER_IDS`) and resolve `?owner=` against it; never trust the
parameter alone.

## Unconfigured is closed

If `OFFICE_DEFAULT_OWNER_ID` is missing, blank, or not a uuid, the endpoint
answers **`503 The office is not open`** for both the listing and `?book=`.
Nothing is served. Callers degrade gracefully:

- the walkable office at `/office/` ignores a non-OK manifest and falls back
  to its own built-in collection;
- the Reader at `/read/<id>` shows "The reading room is closed — try again in
  a moment."

A `503` therefore means *misconfigured*, while a `200` with an empty
`sections` array means *that owner has published nothing* — two different
problems, two different signals.

## Setting it

The value is a uuid from `auth.users` (Supabase dashboard → Authentication →
Users). It is also visible in the live feed today: every `cover` URL is
`…/storage/v1/object/public/cover-images/<owner uuid>/office/<item id>.jpg`.

Set it in Vercel → context-ai → Settings → Environment Variables →
**Production** (and Preview, if previews should show the room), then redeploy.
Locally it goes in `.env`.

## Defence in depth

`api/office.mjs` scopes the SQL with `.eq('owner_id', …)` **and** re-filters
the rows in memory before shaping the response (`selectRoom` / `selectBook`,
both exported and pure). A query that is accidentally widened later cannot
widen the room. `scripts/_verify-office-tenancy.mjs` drives those two
functions with two owners' stubbed rows — including one tenant's published
item filed into the other tenant's section — and asserts nothing crosses:

```
node scripts/_verify-office-tenancy.mjs     # exit 0 = all pass
```

## What stays public on purpose

- The `cover-images` storage bucket is public (migration 010); a jacket is the
  one image the one-way glass lets through.
- The `/read/:id` rewrite in `vercel.json` and the open CORS headers: the
  office front end is meant to run from another origin.
- Text pages only. No storage paths, no file bytes, no document ids, no owner
  ids ever leave this endpoint.
