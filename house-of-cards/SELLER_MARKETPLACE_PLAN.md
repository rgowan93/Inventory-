# Seller Marketplace Plan (multi-seller, fees, feedback, payments)

Status: planning. Builds on the existing single-seller (House of Cards) marketplace.

## Goal
Let approved customers sell their own cards alongside House of Cards, with a flat
**5% platform fee** to House of Cards on every sale, two-way feedback/ratings,
verified-seller badges, and staff moderation (approve/verify/ban).

## The core decision: how money moves (payments)
A multi-seller marketplace must (a) pay each seller, (b) automatically keep your 5%,
and (c) protect buyers. Options considered:

- **Square (current):** great for *your own* sales, but Square has **no native way to
  split a payment and pay out to many independent third-party sellers**. You'd have to
  collect everything into your account and pay sellers manually — not scalable, and you'd
  be holding other people's money (a money-transmitter risk).
- **Stripe Connect (Express)** — **recommended.** Purpose-built for marketplaces:
  - Each seller does a quick **Stripe Express onboarding** (Stripe handles their identity
    verification, bank info, tax forms, payouts). Easiest possible for sellers — they don't
    build anything; they just complete a hosted form and get a payout dashboard.
  - At checkout we charge the buyer once and use **`application_fee_amount`** +
    **`transfer_data.destination`**: the seller is paid automatically, **your 5% is taken
    automatically** into your platform account, and Stripe's processing fee is handled.
  - Buyer protection: Stripe Radar fraud screening + standard card dispute handling.
- **PayPal Commerce Platform** — also supports multiparty payouts but is heavier to
  integrate and onboard; Stripe Express is simpler for non-technical sellers.

### Recommendation
- **House of Cards' own listings:** keep **Square** (already working).
- **Third-party seller listings:** **Stripe Connect Express.** Your 5% lands in your Stripe
  platform balance automatically (you can later pay it to your bank/Square). Sellers are
  told up front: **"A flat 5% platform fee is deducted when your item sells"** (plus Stripe's
  ~2.9% + 30¢ processing, which we disclose).
- Optional later: move everything to Stripe Connect for one consistent system.

### Important legal note (must confirm with an accountant)
Running a marketplace that processes third-party sales can make you a **"marketplace
facilitator,"** which in many states means **you** are responsible for collecting and
remitting sales tax on sellers' sales. This is a real obligation — confirm before launching
third-party selling. (Your own Square sales are unaffected.)

## Data model (additions)
- **sellers**: id (=customer/auth uid), status (`none|requested|approved|banned`),
  verified bool, stripe_account_id, payout_enabled bool, requested_at, approved_by, created_at.
- **listings**: add `seller_id` (null = House of Cards/first-party), keep `created_by`.
- **feedback**: id, order_id, rater_id, ratee_id, role (`buyer_rates_seller|seller_rates_buyer`),
  stars (1–5), comment, created_at. (One per order per direction.)
- **seller stats** (view): avg stars, count, positive %, shown on every listing + seller page.
- **orders**: add `seller_id`, `platform_fee_cents`, `stripe_payment_intent`, `stripe_transfer`.

## Workflows
1. **Request to sell:** customer taps "Request seller account" → `sellers.status='requested'`.
2. **Staff approval:** staff see a **Sellers list** (status, verified, rating, # sales, ban) →
   Approve → seller gets a **Stripe Express onboarding link**; on completion `payout_enabled`.
3. **Selling:** approved seller can create/edit/delete **only their own** listings (RLS by
   `seller_id = auth.uid()`); cannot see/touch others' selling tools. (This is the staff
   "Selling portal" you asked for in #5, generalized to all sellers.)
4. **Buying:** unchanged for buyers; checkout routes payment to the listing's seller (Stripe
   Connect) or to House of Cards (Square) depending on who owns the listing.
5. **Fulfillment:** seller marks shipped/tracking; buyer notified (push).
6. **Feedback:** after completion, buyer rates seller and seller rates buyer (5 stars +
   comment). Totals + percentage shown on the seller's listings and profile.
7. **Moderation:** staff can **verify** a seller (badge), remove verification, or **ban** any
   user (blocks login/selling/buying) at any time.

## Staff "Sellers" list (one screen)
Every seller with: name/username, status, **verified toggle**, **rating (stars) + feedback
count + positive %**, # listings, # sales, and **Ban / Unban**. (This is the list you
described in #7 and ties into #5.)

## Other features worth adding for a best-in-class marketplace
- **Buyer↔seller messaging** per order.
- **Make Offer / Best Offer** on listings.
- **Watchlist / favorites** + price-drop notifications (we already have push).
- **Search filters**: price range, condition, category, seller.
- **Seller storefront page** (their listings + rating).
- **Shipping labels** (Stripe/Shippo/Pirate Ship) so sellers buy postage in-app.
- **Returns/dispute policy** + a dispute flow (even with "all sales final," card disputes
  still happen and must be handled).
- **Payout transparency**: sellers see fees and payouts (Stripe Express dashboard covers this).

## Phasing
- **S1 (no Stripe needed):** seller request → staff approve; `seller_id` on listings; sellers
  edit only their own; staff Sellers list with verify/ban; staff Selling/Customer portal (#5).
- **S2:** Stripe Connect Express onboarding + split checkout with 5% application fee.
- **S3:** two-way feedback + ratings shown on listings/sellers.
- **S4:** messaging, offers, watchlist, filters, storefronts.

## What you'd set up for Stripe (S2)
- Create a **Stripe account**, enable **Connect**, get API keys (secret → Supabase secret).
- We add a `connect-onboard` Edge Function (creates Express accounts + onboarding links) and
  switch seller checkout to a Stripe PaymentIntent with `application_fee_amount` (your 5%).
