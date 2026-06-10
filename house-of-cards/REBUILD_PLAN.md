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
- [x] **Phase 0 — Reset & access** *(done)*
  - Cloud wiped (profiles/companies/friendships/follows/auth.users all cleared).
  - Claude's Supabase access live (MCP) — schema, SQL, migrations, edge functions.
- [x] **Phase 1 — Cloud-first auth** *(done)*
  - Built-in Reggie/Manny/Hailey logins removed; no more local passwords.
  - App login = Supabase login (email or username + password). Password reset by email.
- [x] **Phase 2 — Inventory in the cloud** *(done)*
  - `public.items`: one row per item (owner_id + RLS; friends can read — ready for Phase 4).
  - `public.user_state`: sales, shows, trades, wish list, settings, audit as one private JSONB doc.
  - Local IndexedDB stays as the offline cache; every save pushes changes (debounced) to the cloud.
  - Images currently ride inside item data (data URLs); moving them to a Storage bucket is a later optimization.
- [x] **Bonus — PriceCharting market prices** *(done)*
  - `pricecharting` edge function proxies the API (token never ships in page source).
  - Live market price on Add/Edit, bulk reprice on Inventory, trade valuations, wish-list checks, UPC autofill.
- [x] **Bonus 2 — PriceCharting power features** *(done)*
  - Collection value tracking: daily snapshots + chart on the dashboard (▲/▼ this week).
  - Sell guardrails: cart lines flag "below market"; checkout confirms before selling too low (% in Settings).
  - 📈 Sold comps per item: recent eBay/marketplace sold listings in a modal.
  - Wish-list deal alerts: daily auto price check, 🔥 badge when under your max, manual "check now".
  - 💰 "What's it worth?" scanner: photo → OCR → every grade's market price + suggested cash offer (buy % in Settings).
- [ ] **Phase 3 — Companies + membership + invites**
  - Tables: company_members (role), company_invites.
  - Company inventory view pools members' items. Members can invite by username/email; invitee accepts.
- [x] **Phase 4 — Friends inventory viewing** *(done)*
  - "🃏 View inventory" on each friend opens their for-sale cards (read-only, searchable),
    enforced by the friend-read RLS policy on `items`.
- [x] **Bonus 3 — more PriceCharting features** *(done)*
  - Retail buy/sell benchmarks + eBay/PriceCharting links in the worth scanner & comps.
  - PriceCharting price-guide CSV downloads import directly (auto-detected, matched to inventory).
  - "Top margin in stock" report (market minus cost).

## Notes
- RLS (row-level security) is the key design work: "company members can read each other's items", "friends can read my items", "only I can edit mine".
- Migrating existing local data into the cloud is optional (most current data is test data; a clean start is simplest).
