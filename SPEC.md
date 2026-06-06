# House of Cards — Product Specification

> Full inventory, point-of-sale, and earnings-settlement system for a multi-owner
> Pokémon card & sealed-product business, with a social/trade layer and a paid
> subscription tier for outside vendors.

**Status:** Specification / blueprint. No application code is written yet.
This document is the agreed plan to build against. Read top to bottom, mark up
anything you want changed, and we refine before building.

**Last updated:** 2026-06-06

---

## 1. Vision

House of Cards is the business run by **Reggie, Manny, and Hailey**. This app is
the operating system for that business:

- Track every raw card and sealed product in inventory, tagged to its owner.
- Scan items into a cart and check customers out at card shows — **fully offline**.
- Take payment by Cash, Cash App, Venmo, PayPal, Square, or Zelle and track
  exactly **where the money is** vs. **who earned it**.
- At the end of a show, press **Finalize** and get a PDF that splits the money
  correctly between the three owners, down to the cent.
- Handle trades (including multi-owner trades and buyouts), a prize machine,
  and price adjustments — with a full audit trail of every change.
- A social layer where users friend each other, browse each other's inventory,
  and offer trades.
- Sold to **outside vendors** as a subscription product; House of Cards owners
  use it free.

The guiding principle: **money correctness and a complete audit trail.** Every
price change, discount, cash-out, buyout, and sale is recorded so the end-of-show
split is provable and arguments never happen.

---

## 2. Users & access model

### Org structure: Business → Users
- A **Business** is the top-level account (e.g., "House of Cards").
- A Business has multiple **Users** (members). Inventory ownership is tracked at
  the **user** level.
- **House of Cards** = one Business with three Users: **Reggie, Manny, Hailey**,
  all free, all able to finalize a show.
- **Subscribers** each get their own Business with their own sub-users, working
  the same way. Subscribers pay a monthly fee (with a 3-month free trial).

### Tenancy & isolation
- Each Business's data is **completely walled off** from every other Business,
  enforced at the database layer (Supabase Row-Level Security). A subscriber can
  never see House of Cards data or another subscriber's data, except items
  explicitly shared through the **social layer**.

### Roles
- **All House of Cards members can finalize a show, edit inventory, and run the
  POS.** (No admin-only restriction requested.)
- Every sensitive action is **audit-logged** with who/when regardless of role.
- Subscriber businesses can define their own members similarly.

### Billing
- Outside vendors: monthly subscription via **Stripe**, **3-month free trial** on
  signup.
- House of Cards members: **free** (flag on the business/account bypasses billing).
- Because the app is distributed **outside** the Apple/Google stores, billing is
  direct (no 30% store cut, no in-app-purchase requirement).

---

## 3. Platform, distribution & tech stack

### Platform decisions (locked)
- **Installable Web App (PWA)** + **Android app**, built from one codebase.
- **Offline-first** — POS, cart, inventory, and scanning must work with no
  internet and sync when reconnected. This is mandatory for card shows.
- **App-camera scanning** for v1 (barcode/QR). Bluetooth scanner support is a
  later add-on; the architecture leaves a hook for it.
- Android tablets will be used at shows; iPhone users use the installable PWA.

### Distribution
- **Phase 0:** local build that Reggie tests, then deploy to web.
- Shared by **link, install-per-phone** (not on Apple/Google stores yet):
  - **Android:** sideloaded APK via link.
  - **iPhone:** installable PWA (add to home screen). Native iOS via TestFlight
    is a possible later step.

### Stack
- **Frontend:** React + TypeScript PWA (responsive, tablet-first). Wrapped for
  Android (e.g., Capacitor) to produce the installable APK and access native
  camera/printing reliably.
- **Backend / DB / Auth / Storage:** **Supabase**
  - Postgres database
  - Supabase Auth (logins)
  - Supabase Storage (card photos, generated PDFs, label assets)
  - Row-Level Security for tenant isolation
- **Offline sync:** local on-device database (e.g., IndexedDB / SQLite via the
  Android wrapper) that mirrors the user's working set and syncs to Supabase on
  reconnect, with conflict handling (see §10).
- **Billing:** Stripe (subscriptions + trials).
- **PDF generation:** server-side or client-side PDF for the finalize report.
- **Backups:** automated scheduled export/snapshot of each business's data to
  secure storage (belt-and-suspenders beyond Supabase's own backups). GitHub is
  used for **code**, not as the live database.

### Secrets handling
- Supabase **anon key** ships in the client (safe by design with RLS).
- Supabase **service_role key** and Stripe secret keys live only in server-side
  environment variables / secrets — **never** committed or pasted into chat.

---

## 4. Design system

Derived from the House of Cards logo. Overall direction: **dark premium / luxe**
with the logo's bold, high-contrast, thick-outline personality — confident and a
little playful, never a generic AI dashboard.

### Palette
| Role | Color | Approx hex |
|---|---|---|
| Primary accent (hero) | Gold | `#F4B400` |
| Secondary | Royal blue | `#2160B0` |
| Alert / sold / destructive | Pokéball red | `#E23B2E` |
| Light surface / text-on-dark | Cream | `#F3E9D6` |
| Base background | Near-black charcoal | `#15161A` (to be tuned) |
| Outlines / dividers | Bold black | `#000000` |

> Final palette will be tuned against the actual logo file once provided as an
> asset; hexes above are read from the logo image.

### Principles
- Dark charcoal base, **gold** as the primary call-to-action accent, **blue**
  secondary, **red** reserved for warnings/delete/sold.
- Strong borders and weighty type echoing the logo's comic-bold outline style.
- **High contrast and large tap targets** — must be readable and fast under poor
  card-show lighting on a tablet.
- Logo and card-suit motifs used as subtle accents, not clutter.

---

## 5. Data model (entities)

High-level entities. Field lists are representative, not exhaustive.

### Business
`id, name, type (owner | subscriber), billing_status, trial_ends_at,
created_at`

### User (member)
`id, business_id, name, email, role, created_at`

### PaymentAccount (per business)
Maps a payment method to who receives it.
`id, business_id, method (cash|cashapp|venmo|paypal|square|zelle),
owner_user_id (nullable), behavior (fixed_owner | prompt_per_sale | drawer)`

House of Cards configuration:
| Method | Behavior | Receives to |
|---|---|---|
| Cash | drawer | shared drawer (no owner) |
| Venmo | fixed_owner | **Manny** |
| Cash App | fixed_owner | **Reggie** |
| PayPal | fixed_owner | **Reggie** |
| Square | fixed_owner | **Reggie** |
| Zelle | **prompt_per_sale** | **ask at checkout** (Reggie/Manny/Hailey) |

### CardProduct (catalog identity — what a card *is*)
`id, category (Pokemon|One Piece|...), set, product_name, card_number, rarity,
variance (Normal|Holofoil|Reverse Holofoil|...), language (EN default|JP|CN|...),
grade (Ungraded|graded co.+#), stock_image_url`

> **Identity/match key:** `category + set + card_number + variance + grade +
> language`. Untagged language defaults to **English**. JP/CN are explicitly
> tagged in source data and are part of identity (a JP and EN card with the same
> number are different items).

### InventoryItem (a physical copy you own)
`id, business_id, owner_user_id, card_product_id, condition
(NM|LP|MP|HP|DMG — raw cards), barcode (unique), qr_payload,
cost_basis (owner-only, never shown to others), list_price,
suggested_price (from feeds/CSV), price_override (bool),
photos[] (front required; back + extras optional), status
(intake|available|in_cart|sold|traded|hold), date_added, location (optional)`

- **Each physical copy = one row with a unique barcode**, even for duplicates.
- `price_override = true` means feeds/CSV never auto-change `list_price`; they may
  still update `suggested_price` for reference.
- **Graded cards:** `list_price` is owner-set; CSV/feeds update only
  `suggested_price`.

### Show (a card-show event / register session)
`id, business_id, name, location, date, status (open|finalized),
cash_float (default 200, belongs to Reggie, persists between shows),
prize_machine_plays_start (default 400), finalized_at, pdf_url`

### Device / RegisterSession
`id, show_id, user_id, device_label, checked_in_at` — devices check into a show;
inventory reconciles across them on reconnect.

### Sale / Transaction
`id, show_id, created_by_user_id, created_at, status (completed|voided),
line_items[], payment_splits[], subtotal, total, notes`

### SaleLineItem
`id, sale_id, inventory_item_id (nullable for manual items),
description, owner_user_id, list_price, sold_price, discount_amount,
discount_reason (optional), is_manual (bool), is_bundle_member (bool),
bundle_id (nullable), item_type (card|sealed|prize_play|manual)`

- **Adjusted prices** record `list_price` vs `sold_price` and a `discount_reason`.
- **Manual line items** (supplies, "5 commons for $1") have no inventory link.
- **Bundles** group multiple copies under one price while each copy still records
  as sold (for history + splits).

### PaymentSplit
`id, sale_id, method, amount, received_by_user_id (resolved: fixed owner, drawer,
or the Zelle prompt answer)`

A single sale can have multiple splits (e.g., $60 Venmo + $40 cash).

### CashOut (mid-show personal withdrawal)
`id, show_id, user_id, amount, note, created_at` — subtracted from that person's
payout at finalize.

### PrizeMachine (per show)
`id, show_id, plays_start (400), plays_sold, price_per_play (10),
split (Reggie 50% / Manny 50%)` — revenue split 50/50 Reggie↔Manny (not Hailey).
Resets to 400 plays each show.

### Trade
`id, show_id, created_by_user_id, created_at,
outgoing_items[] (inventory copies leaving, each with owner + value),
incoming_items[] (new copies received, with assigned owner after buyout),
customer_trade_value (what we credited the customer — not shown customer-side),
our_total_out_value, trade_percentage, buyout (see below), notes`

#### Trade buyout
When outgoing items belong to **multiple owners**, the incoming inventory is
allocated via a **buyout**: one member pays the others their share value and
**owns all incoming inventory**. Settled **at finalize**, and the finalize report
**lists the full trade detail** (both sides, per-owner outgoing values, incoming
items, who bought out whom, trade %) so it can be squared correctly.

### Friendship & Visibility (social)
`Friendship: id, user_a, user_b, status`
`VisibilitySetting: per-account default + per-item override —
{ item_visible_to_friends, show_pricing_to_friends }`
- **Cost basis is never visible to anyone but the owner**, no toggle.

### TradeOffer (social, in-app)
`id, from_user, to_user, offered_items[], requested_items[], status
(pending|accepted|countered|declined)` — an accepted offer flows into the **Trade**
module and updates both inventories automatically.

### WantListEntry
`id, user_id, card_product_id (+ optional condition), note` — when any business
member **scans** a matching card, the wanting member is **pinged**.

### AuditLog
`id, business_id, user_id, action, entity, before, after, created_at` — covers
price edits, cash-outs, voids, buyouts, overrides, finalize, etc.

### PriceSource (pluggable, future)
`id, name (tcgplayer|ebay_solds|collectr|cardladder|alt|aggregator),
status (manual|connected), config` — each price feed is an interchangeable module;
the app works fully without any connected and gets smarter as each is approved.

---

## 6. Feature specifications

### 6.1 Inventory
- List view: each item shows **photo, card identity, condition, owner, list
  price, current/suggested market price, barcode status**.
- Filter/search by set, owner, condition, status, price, etc.
- **Edit any price** at any time (e.g., correct graded-card pricing before a
  show). Setting a manual price flags `price_override` so feeds/CSV won't
  overwrite it (they still update `suggested_price`).
- Owner assignment; multiple copies of the same card, each individually owned and
  barcoded.
- **Ownership transfer** between members (logged).
- **Hold/layaway:** pull a copy out of "available" without selling it.

### 6.2 Intake process (how items become sale-ready)
Triggered by manual add, scan-new, or CSV import. Each item must clear intake:
1. **Confirm card identity** (set, number, language, variance) against catalog.
2. **Confirm condition** (NM/LP/MP/HP/DMG for raw).
3. **Photo:** **front required**; back + extra photos optional.
4. **Assign owner** and **price**.
5. **Print barcode label.** **Barcode is required before an item enters
   sellable inventory.**

Nothing reaches `available` status without a human confirmation step — this is
the safeguard against misidentified or mispriced cards hitting the floor.

### 6.3 Scanning
- **Barcode/QR scan** of *our own* labels — fast, 100% reliable — used for
  cart/POS, finding which copy sold, and want-list pings.
- **Visual card recognition** (camera identifies an unknown card) is **deferred
  to a later phase** — it requires ML/paid recognition services and is never
  100%; it must never auto-add without human confirm. v1 relies on barcode + CSV
  + manual intake.

### 6.4 Labels & printing
- **Printer:** off-brand **4×6 thermal**.
- **Batch grid print:** lay out as many small labels as fit on a 4×6 sheet;
  Reggie cuts them apart.
- Each label shows, **above the barcode**, a human-readable identifier:
  **card name · set · number · condition**.
- **1D barcode** (internal POS scanning) + **optional QR code** (customer scans
  with a normal phone camera → opens a page with photos + price). QR is optional;
  **barcode is required.**

### 6.5 Point of sale (offline)
- **Scan to add to cart**; scan more to keep adding; remove from cart.
- **Adjust line price** when taking less; records list vs sold price +
  optional **discount reason**.
- **Manual line items** (non-inventory: supplies, bulk lots).
- **Bundles** ("3 for $X") — one price, each copy still recorded sold.
- **Prize-machine play** is a scannable $10 item (bundle/discount allowed).
- **Checkout / payment form:** choose method(s) — Cash, Cash App, Venmo, PayPal,
  Square, **Zelle (prompts who received it)**. Multiple methods per sale allowed.
- Works fully offline; queues and syncs on reconnect.

### 6.6 Cash drawer
- Starts at **$200 float** every show. The $200 is **Reggie's**, **stays in the
  drawer between shows**, and is **never distributed**.
- **Mid-show cash-outs:** any member can subtract cash they took during the show
  (e.g., buying product); subtracted from that person's payout at finalize.
- **End-of-show reconciliation:** app shows **expected cash =
  $200 + cash sales − cash-outs**; user counts actual cash and records the
  **over/short** variance.

### 6.7 Prize machine
- **$10/play, 400 plays per show, resets to 400 each show.**
- Bundles/discounts allowed (recorded like card discounts).
- Revenue **split 50/50 Reggie ↔ Manny** (Hailey excluded), tracked separately so
  finalize gives each his half regardless of payment method.

### 6.8 Trades
- Build a trade: outgoing inventory (possibly multiple owners) vs incoming items.
- Internal view shows **both sides' values + trade %** and **cost basis (hidden
  from customer view)** so you can see your trade percentage.
- **Condition selectable** on raw cards to base value on (NM/LP/MP/HP/DMG).
- **Buyout** assigns incoming inventory to a single owner; settled at finalize;
  full trade detail listed on the report.

### 6.9 Finalize show → settlement & PDF
The core deliverable. On finalize, the app computes and produces a PDF with:

**A. Where the money physically is (buckets):**
- Cash drawer (expected vs counted, variance, minus the $200 float retained)
- Reggie's accounts: Cash App, PayPal, Square (+ his Zelle receipts)
- Manny's accounts: Venmo (+ his Zelle receipts)
- Hailey's Zelle receipts (if any)

**B. What each person earned:**
- Sum of their sold items at **actual sold price**
- + prize-machine share (Reggie/Manny 50/50)
- − their mid-show cash-outs
- ± trade buyout settlements

**C. Settlement (reconcile A vs B):**
- Because the person who *holds* money (whose account received it) differs from
  who *earned* it, compute net **who-pays-whom** to square everyone up.
- Example: Manny's Venmo holds money earned on Reggie's cards → Manny owes Reggie
  that portion; netted across all buckets into minimal transfers.

**D. Full detail / audit:**
- Every transaction, every line item with list vs sold price and discount
  reasons, per-source payout per person, **per-owner profit** (sold − cost
  basis), full trade breakdowns with buyouts, cash-out log, prize-machine totals,
  drawer reconciliation.

PDF is saved to the show record and shareable.

### 6.10 Sold history & analytics
- Database of everything sold, **searchable** (by card, set, date, owner, etc.).
- **Trends / velocity:** how often a card sells, trending items — signals for
  what to buy when you see it.
- **Aging report:** how long an item has sat (discount/push candidates).
- Sliceable **per show/event**.

### 6.11 Social layer
- **Friends:** add other users; browse friends' visible inventory.
- **Visibility controls:** per-account default + per-item override for
  `item_visible_to_friends` and `show_pricing_to_friends`. **Cost basis never
  shown to anyone.** (Per-friend granular visibility is a possible later add.)
- **In-app trade offers:** build a basket against a friend's items; accept /
  counter / decline; accepted offers flow into the Trade module and update both
  inventories automatically.
- **Want-list:** flag cards you're hunting; when a business member **scans** a
  match, the wanting member is **pinged**.
- Moderation basics (block/decline) once outside subscribers can interact.

### 6.12 CSV price/inventory import
- Upload a CSV (e.g., a Collectr export). Columns confirmed to support reliable
  matching: Category, Set, **Card Number**, Rarity, **Variance**, **Grade**,
  **Condition**, Market Price, **Price Override**, etc.
- **Match key:** `Category + Set + Card Number + Variance + Grade + Condition +
  Language`. Untagged language = English.
- **Tied to the uploading user's inventory.**
- **Review screen:** list of parsed rows, each with an **editable price**;
  **swipe a row to drop it**; rows color-coded **matched / ambiguous / unmatched**.
- **Override handling:** rows already flagged as override **are not auto-repriced**;
  for everything else, show **marked price → updated price** with a per-row choice:
  **Keep price / Use new price / Enter custom amount**.
- **Two top-level modes:**
  - **Update prices only** — change prices on existing inventory; unmatched rows
    ignored/flagged.
  - **Add new + update** — also create inventory for unmatched rows. New items
    enter the **intake queue** (photo/confirm/condition/barcode) — not instantly
    sellable.
- **Graded cards:** CSV never overrides graded `list_price`; updates only
  `suggested_price`.
- **Dry-run summary** before commit ("X updated, Y added, Z skipped") with undo.

### 6.13 Subscriptions (outside vendors)
- Sign up → **3-month free trial** → monthly billing via Stripe.
- Own Business + sub-users, fully isolated.
- House of Cards members free.
- **Price is currently $0.00** (decided later, after the app proves useful). The
  billing plumbing is in place but charges nothing until the price is set.

### 6.14 Out of scope (explicitly decided)
- **No sales-tax** collection or reporting.
- **No digital receipts** to customers (text/email/QR).

---

## 7. The money/settlement engine (worked example)

Illustrative end-of-show state:

- Cash drawer counted: **$700** (float $200 retained by Reggie → **$500**
  distributable cash)
- Manny's Venmo: **$600**
- Reggie's Cash App: **$1,000**; Square: **$250**
- Zelle: as attributed per sale to whoever was selected

**Step 1 — Earnings by person** (from sold line items at sold price + prize
share − cash-outs ± buyouts). Suppose: Reggie earned $1,300, Manny $900,
Hailey $850.

**Step 2 — Holdings by person** (where money landed):
- Reggie holds Cash App $1,000 + Square $250 = $1,250 (+ any of his Zelle)
- Manny holds Venmo $600 (+ his Zelle)
- Drawer holds $500 distributable cash (belongs to no one yet)

**Step 3 — Settle:** allocate drawer cash + compute transfers so each person ends
with exactly their earned amount, minimizing the number of payments. The PDF
states the final "Reggie pays Manny $X; Hailey takes $Y from drawer; …" lines
plus all backup detail.

This engine is the highest-correctness part of the system and gets a dedicated
**dry-run/test-show** validation pass before being trusted live.

---

## 8. Phased roadmap

> Decision: write the **full spec first (this document)**, then **build in order**.
> First deployment target is a **local build Reggie tests**, web later.

### Phase 1 — Core (runs a real show)
- Auth, Business → Users, House of Cards seeded (Reggie/Manny/Hailey, free)
- Inventory: owners, conditions, photos, manual price + override, hold/transfer
- Intake + **barcode generation, 4×6 batch label printing**, app-camera barcode
  scanning
- Offline POS: cart, price adjust + reasons, manual items, bundles
- Payments: all methods incl. **Zelle prompt**; multi-method per sale
- Cash drawer ($200 float, cash-outs, reconciliation)
- Prize machine ($10, 400/show, 50/50 Reggie/Manny)
- **Finalize → settlement engine → PDF**
- Sold history + search
- **→ Practice/dry-run show to validate the money math**

### Phase 2 — Growth
- CSV import flow (two modes, review, override handling, dry-run)
- Social: friends, visibility, in-app trade offers
- Trade module + multi-owner buyouts + want-list scan pings
- Analytics: trends/velocity, aging report
- QR codes on labels + customer-facing photo/price page

### Phase 3 — Scale & money-in
- Subscriptions + 3-month trial billing (Stripe), multi-tenant onboarding
- Price-feed integrations as approved (TCGplayer, eBay solds, Collectr,
  Card Ladder, Alt) — each a pluggable module
- Visual card recognition (camera identifies unknown cards)
- Native iOS via TestFlight (optional)

---

## 9. External dependencies (parallel business tasks, not coding)

These require **applications/partnerships**, not code, and **v1 is manual-first**
without them. The app degrades gracefully (manual entry + CSV) and improves as
each is approved:

| Source | What it gives | Reality |
|---|---|---|
| TCGplayer | Singles/sealed market prices | Gated partner/seller API; apply |
| eBay (sold comps) | Last-solds | Marketplace Insights API needs approval; **130point has no public API** |
| Collectr | Singles/sealed pricing | No public API known; partnership/data license |
| Card Ladder / Alt | Graded pricing | No public API; partnership or manual |
| pokemontcg.io / JustTCG | Card identity + some pricing | Usable now as identity/fallback source |

---

## 10. Risks & mitigations

- **Offline multi-device sync / double-sell:** register-session model; unique
  per-copy barcodes prevent selling the same physical card twice; reconcile on
  reconnect with clear conflict messaging. *Highest-care engineering area.*
- **Visual recognition cost/accuracy:** deferred to Phase 3; never auto-commit.
- **Money correctness:** dedicated settlement engine + audit log + mandatory
  dry-run show before trusting live.
- **Multi-tenant data isolation:** Supabase RLS designed in from day one.
- **Running costs (esp. photo storage/bandwidth):** estimate per-user infra cost;
  price subscription to cover with margin.
- **Legal/tax:** recording (not transmitting) money keeps out of money-transmitter
  territory; still need basic **Terms of Service + Privacy Policy** and tax
  handling for subscription income. (Not legal advice; confirm with a professional.)
- **iOS PWA quirks:** acceptable for v1; native iOS later if needed.

---

## 11. Open items to confirm / future decisions

- **Sales tax:** not collected. **Decided — no sales-tax feature.**
- **Digital receipts:** **Decided — none** (no text/email/QR receipt to customer).
- **Subscriber price:** currently **$0.00**; will be set later after verifying how
  useful the app is in real use. Billing plumbing (Stripe + 3-month trial) is
  built but priced at $0 until adjusted.
- Final palette tuning against the actual logo asset file.
- Per-friend granular price visibility (vs single on/off) — later.
- Returns/voids policy detail.

---

## 12. Locked decisions (summary)

- **Org:** House of Cards = Reggie, Manny, Hailey; all free; all can finalize.
  Subscribers = own isolated business + sub-users, paid w/ 3-month trial.
- **Stack:** Supabase backend; PWA + Android; offline-first; app-camera scanning;
  automated backups (GitHub = code only).
- **Design:** dark premium/luxe from the logo — gold primary, blue secondary, red
  alerts, cream text, bold outlines.
- **Payments:** Cash→drawer; Venmo→Manny; Cash App/PayPal/Square→Reggie;
  **Zelle→prompt who received it per sale**.
- **Cash drawer:** $200 float is Reggie's, stays between shows, never distributed.
- **Prize machine:** $10/play, 400/show (resets), **50/50 Reggie/Manny**.
- **Trades:** multi-owner outgoing; buyout assigns incoming inventory; settled at
  finalize with full detail listed.
- **Inventory:** per-copy unique barcode required before sellable; conditions
  NM/LP/MP/HP/DMG; front photo required; manual overrides protected from feeds;
  graded prices owner-set (feeds update suggested only).
- **CSV:** match on category+set+number+variance+grade+condition+language; two
  modes; override rows protected; Keep/Use New/Custom per row; swipe to remove;
  tied to uploader; dry-run + undo.
- **Labels:** 4×6 thermal, batch grid, human-readable identity above barcode,
  optional QR for customers.
- **Build order:** full spec now → build Phase 1 → 2 → 3; local test build first,
  web later.
