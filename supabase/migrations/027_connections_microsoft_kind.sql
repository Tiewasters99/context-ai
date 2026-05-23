-- Context.ai Migration 027: extend connections.kind to include 'microsoft_365'.
--
-- Adds Microsoft 365 (OneDrive + SharePoint) as a connectable integration.
-- One OAuth flow grants both Files.Read.All (OneDrive) and Sites.Read.All
-- (SharePoint), so they share a single connection row keyed by
-- (user_id, 'microsoft_365'), in the same shape as gmail / google_calendar.
--
-- Apply order: after 026.

alter table public.connections
  drop constraint if exists connections_kind_check;

alter table public.connections
  add constraint connections_kind_check
  check (kind in ('gmail', 'google_calendar', 'microsoft_365'));

notify pgrst, 'reload schema';
