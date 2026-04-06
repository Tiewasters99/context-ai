-- Context.ai Initial Schema
-- Run this in Supabase SQL editor or as a migration

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- Users profile (extends Supabase auth.users)
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  display_name text not null default '',
  avatar_url text,
  pricing_tier text not null default 'free' check (pricing_tier in ('free', 'pro', 'max')),
  assistant_mode text not null default 'blind' check (assistant_mode in ('blind', 'observer', 'collaborative')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Clientspaces (one per user)
create table public.clientspaces (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null unique,
  name text not null default 'My Workspace',
  cover_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Serverspaces
create table public.serverspaces (
  id uuid primary key default uuid_generate_v4(),
  clientspace_id uuid references public.clientspaces(id) on delete cascade not null,
  name text not null,
  description text,
  cover_url text,
  icon text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Serverspace members
create table public.serverspace_members (
  id uuid primary key default uuid_generate_v4(),
  serverspace_id uuid references public.serverspaces(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  joined_at timestamptz not null default now(),
  unique(serverspace_id, user_id)
);

-- Matterspaces
create table public.matterspaces (
  id uuid primary key default uuid_generate_v4(),
  serverspace_id uuid references public.serverspaces(id) on delete cascade not null,
  name text not null,
  description text,
  cover_url text,
  icon text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Content items (pages, lists, databases, documents)
create table public.content_items (
  id uuid primary key default uuid_generate_v4(),
  parent_id uuid references public.content_items(id) on delete set null,
  space_id uuid not null, -- references clientspace, serverspace, or matterspace
  space_type text not null check (space_type in ('clientspace', 'serverspace', 'matterspace')),
  content_type text not null check (content_type in ('page', 'list', 'database', 'document')),
  title text not null default 'Untitled',
  content jsonb default '{}',
  icon text,
  cover_url text,
  is_locked boolean not null default false,
  locked_by uuid references public.profiles(id),
  position integer not null default 0,
  created_by uuid references public.profiles(id) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tags
create table public.tags (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  color text not null default '#6366f1',
  space_id uuid not null,
  created_at timestamptz not null default now(),
  unique(name, space_id)
);

-- Content-tag junction
create table public.content_tags (
  content_id uuid references public.content_items(id) on delete cascade not null,
  tag_id uuid references public.tags(id) on delete cascade not null,
  primary key (content_id, tag_id)
);

-- Cross-references between content items
create table public.cross_references (
  id uuid primary key default uuid_generate_v4(),
  source_id uuid references public.content_items(id) on delete cascade not null,
  target_id uuid references public.content_items(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  unique(source_id, target_id)
);

-- Indexes
create index idx_content_items_space on public.content_items(space_id, space_type);
create index idx_content_items_parent on public.content_items(parent_id);
create index idx_content_items_type on public.content_items(content_type);
create index idx_serverspace_members_user on public.serverspace_members(user_id);
create index idx_serverspaces_clientspace on public.serverspaces(clientspace_id);
create index idx_matterspaces_serverspace on public.matterspaces(serverspace_id);

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.clientspaces enable row level security;
alter table public.serverspaces enable row level security;
alter table public.serverspace_members enable row level security;
alter table public.matterspaces enable row level security;
alter table public.content_items enable row level security;
alter table public.tags enable row level security;
alter table public.content_tags enable row level security;
alter table public.cross_references enable row level security;

-- RLS Policies

-- Profiles: users can read any profile, update own
create policy "Profiles are viewable by everyone" on public.profiles for select using (true);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- Clientspaces: owners only
create policy "Users can view own clientspace" on public.clientspaces for select using (auth.uid() = user_id);
create policy "Users can update own clientspace" on public.clientspaces for update using (auth.uid() = user_id);
create policy "Users can insert own clientspace" on public.clientspaces for insert with check (auth.uid() = user_id);

-- Serverspaces: members can view, owner can modify
create policy "Members can view serverspaces" on public.serverspaces for select
  using (exists (
    select 1 from public.serverspace_members
    where serverspace_members.serverspace_id = serverspaces.id
    and serverspace_members.user_id = auth.uid()
  ));
create policy "Owners can insert serverspaces" on public.serverspaces for insert
  with check (exists (
    select 1 from public.clientspaces
    where clientspaces.id = serverspaces.clientspace_id
    and clientspaces.user_id = auth.uid()
  ));
create policy "Admins can update serverspaces" on public.serverspaces for update
  using (exists (
    select 1 from public.serverspace_members
    where serverspace_members.serverspace_id = serverspaces.id
    and serverspace_members.user_id = auth.uid()
    and serverspace_members.role in ('owner', 'admin')
  ));

-- Members: members can view members of their serverspaces
create policy "Members can view serverspace members" on public.serverspace_members for select
  using (exists (
    select 1 from public.serverspace_members as sm
    where sm.serverspace_id = serverspace_members.serverspace_id
    and sm.user_id = auth.uid()
  ));
create policy "Admins can manage members" on public.serverspace_members for insert
  with check (exists (
    select 1 from public.serverspace_members as sm
    where sm.serverspace_id = serverspace_members.serverspace_id
    and sm.user_id = auth.uid()
    and sm.role in ('owner', 'admin')
  ));

-- Content items: based on space membership
create policy "Users can view content in their spaces" on public.content_items for select using (true);
create policy "Users can insert content" on public.content_items for insert with check (auth.uid() = created_by);
create policy "Users can update unlocked content" on public.content_items for update
  using (
    (not is_locked) or (locked_by = auth.uid())
  );

-- Tags
create policy "Tags are viewable" on public.tags for select using (true);
create policy "Users can create tags" on public.tags for insert with check (true);

-- Content tags
create policy "Content tags are viewable" on public.content_tags for select using (true);
create policy "Users can manage content tags" on public.content_tags for insert with check (true);
create policy "Users can remove content tags" on public.content_tags for delete using (true);

-- Cross references
create policy "Cross refs are viewable" on public.cross_references for select using (true);
create policy "Users can create cross refs" on public.cross_references for insert with check (true);
create policy "Users can delete cross refs" on public.cross_references for delete using (true);

-- Function to auto-create profile and clientspace on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));

  insert into public.clientspaces (user_id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)) || '''s Workspace');

  return new;
end;
$$ language plpgsql security definer;

-- Trigger for new user signup
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Updated_at trigger function
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Apply updated_at triggers
create trigger update_profiles_updated_at before update on public.profiles for each row execute function public.update_updated_at();
create trigger update_clientspaces_updated_at before update on public.clientspaces for each row execute function public.update_updated_at();
create trigger update_serverspaces_updated_at before update on public.serverspaces for each row execute function public.update_updated_at();
create trigger update_matterspaces_updated_at before update on public.matterspaces for each row execute function public.update_updated_at();
create trigger update_content_items_updated_at before update on public.content_items for each row execute function public.update_updated_at();
