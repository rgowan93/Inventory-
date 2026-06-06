# House of Cards — Cloud Rebuild Plan

Goal: move from a local/offline app to a multi-user cloud app.

## Target model
- Every person has their **own** account (email + password) = one login for app + cloud.
- A person's **inventory/sales/shows live in the cloud**, owned by them, synced to any device.
- **Companies** group people:
  - A company has members (with roles: owner/admin/member).
  - **Company inventory view = all members' inventory pooled together.**
  - Members (or admins) can **invite** other users to join the company.
- **Friends** are personal (independent of company).
  - Tap a friend → **View inventory** to browse their collection (read-only).

## Phases
- [ ] **Phase 0 — Reset & access**
  - Wipe cloud (`truncate public.profiles cascade; delete from auth.users;`) and local (factory reset).
  - Enable Claude's Supabase access: network policy allows `*.supabase.co` + service_role key as an env secret.
- [ ] **Phase 1 — Cloud-first auth**
  - Remove built-in Reggie/Manny/Hailey logins.
  - App login = Supabase login (sign up / sign in with email + password). One identity, no more tangling.
- [ ] **Phase 2 — Inventory in the cloud**
  - New tables: items, sales, shows (owned by user_id), image storage.
  - App reads/writes the cloud; offline cache optional later.
- [ ] **Phase 3 — Companies + membership + invites**
  - Tables: companies, company_members (role), company_invites.
  - Company inventory view pools members' items. Members can invite by username/email; invitee accepts.
- [ ] **Phase 4 — Friends inventory viewing**
  - Friends (existing) get a "View inventory" action (read-only) with RLS allowing friends to read each other's items.

## Notes
- RLS (row-level security) is the key design work: "company members can read each other's items", "friends can read my items", "only I can edit mine".
- Migrating existing local data into the cloud is optional (most current data is test data; a clean start is simplest).
