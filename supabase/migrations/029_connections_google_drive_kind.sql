-- Extend connections.kind to include 'google_drive' (and keep
-- 'microsoft_365' on the books for the deferred OneDrive Phase 2).
--
-- Drive is the outbound counterpart to Gmail/Calendar inbound: same
-- OAuth client, same google-connect/google-callback flow parameterised
-- by kind, just a different scope (drive.file — non-sensitive, lets us
-- create files in the user's Drive but not see anything we didn't
-- create). The 'Export to Drive' button on DocumentReader (and later
-- pages) uses this connection.

alter table connections
  drop constraint if exists connections_kind_check;

alter table connections
  add constraint connections_kind_check
  check (kind in ('gmail', 'google_calendar', 'microsoft_365', 'google_drive'));
