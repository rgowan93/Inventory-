# House of Cards — Marketplace Plan (Square-integrated)

Status: design locked, not yet built. This is the working blueprint.

## Locked decisions
1. **Checkout:** Embedded **Square Web Payments SDK** (card fields rendered by Square inside our
   checkout; the card number/CVV/expiry never touch our site or database).
2. **Card processing cost:** **Baked into listing prices** — no separate surcharge line
   (avoids state surcharge laws and card-network caps).
3. **Sales tax:** **Collected** (Florida). Rate configurable; confirm rate/registration with an accountant.
4. **Customer accounts:** **Email + password** via Supabase Auth, with a **unique phone** (one account per phone).

## Hard compliance rules (non-negotiable)
- **Never store or transmit raw card data** (PAN/CVV/expiry) through our app or DB. Storing CVV is
  prohibited outright. Square tokenization keeps us at the lowest PCI tier (SAQ A).
- We only ever persist Square's `payment_id` / `order_id`.
- All money math (subtotal + shipping + tax) is computed **server-side** in a Supabase Edge Function.
  The browser never sets the price that gets charged.
- Required published policies: **Terms of Sale (all sales final), Refund/Return policy, Privacy Policy.**

## Architecture
- **Frontend:** existing static site (GitHub Pages) + Square Web Payments SDK.
- **Backend:** Supabase **Edge Functions** (Deno) — already in use (`scrydex`). New functions:
  - `checkout` — verifies cart/prices, computes shipping+tax, charges Square (secret token), writes order.
  - `square-webhook` — receives payment/refund events, keeps order status truthful.
- **Auth:** Supabase Auth (customers) + existing staff system (staff).
- **Secrets:** Square Access Token stored as a Supabase secret — never in the website.

### Charge flow
```
Browser (Square card field) --token--> checkout Edge Fn --> Square Payments API
                                       (recompute total)       |
                                       write order  <----- payment_id/status
   <-------------- confirmed --------------
square-webhook <---- async payment/refund events ---- Square
```

## Data model (Supabase)
- **customers**: auth user id, name, email, **phone (unique)**, created_at.
- **listings**: id, title, description, condition, price_cents, qty, photos[], local_pickup bool,
  shipping_offered bool, shipping_cost_cents, status (active/sold/hidden), created_by, created_at.
- **orders**: id, customer_id, status, subtotal_cents, shipping_cents, tax_cents, grand_total_cents,
  fulfillment (pickup|ship), shipping name/address/city/state/zip/phone, billing_same bool + billing addr,
  square_payment_id, tracking_number, pickup_slot, created_at, updated_at.
- **order_items**: order_id, listing_id, title/price/qty snapshot.
- **reviews**: extend existing; linked to a completed order.
- No card columns anywhere.

## Tabs / UX
**Customer (after sign-in at top):**
- Marketplace — browse, item detail, add to cart.
- Cart — multiple items, choose pickup or shipping, live total (items + shipping + tax), pay via Square.
- My Orders — live status + previous purchases; leave review when complete.

**Staff:**
- Listings — create/edit/delete (eBay Buy-It-Now style; pickup-only or shipping + custom shipping cost).
- New Orders — name, full shipping address + zip, phone, items, fulfillment, Square payment status.
  (No raw card — Square already charged it.)
- Fulfillment — mark Ready for pickup (time slots) or add tracking number.
- Completed — archive; unlocks customer review.

## Order lifecycle
Placed -> Paid (Square) -> Preparing -> (Ready for pickup w/ slots | Shipped w/ tracking)
-> Complete -> Review.  "All sales final" shown and stored at checkout.

## Inventory safety
Singles are one-of-one: mark `sold` atomically at successful payment to prevent double-sell.

## Phased rollout
1. **Accounts & cleanup** (no Square needed): customer accounts (unique phone), convert "Join our page"
   into account creation, staff member-remove. Customer sign-in portal.
2. **Listings & Marketplace**: staff create listings; customers browse.
3. **Cart & Square checkout**: Edge Functions + Square payment + orders. (Needs Square credentials.)
4. **Staff fulfillment**: New Orders / Fulfillment / Completed; pickup slots & tracking.
5. **Reviews & purchase history.**
6. **Future — Auctions**: timed listings, bids, auto-extend, outbid notifications (model designed to extend).

## What staff must provide / do in Square (for Phase 3)
1. Square Developer Dashboard -> create an **Application**.
   - Copy **Application ID** (public) and **Access Token** (secret).
   - Copy the **Location ID**.
2. Start in **Sandbox** (test tokens), then switch to **Production**.
3. We add a **webhook** subscription -> our `square-webhook` Edge Function (+ signing key).
4. Confirm bank deposit + online payments are active.
5. Decide the **FL tax rate** to apply (state 6% + county surtax; e.g., Escambia ~7.5%).

## Open follow-ups
- Confirm FL tax rate and whether shipping is taxable (FL: taxable if shipping is mandatory/not separately
  stated — accountant call).
- Draft starter Terms / Refund / Privacy text for review (not legal advice).
