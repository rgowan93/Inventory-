/* ----------------------------------------------------------------------------
   House of Cards — cloud connection (Supabase)

   Fill these two values from your Supabase project:
     Supabase dashboard  →  Project Settings  →  API
       • SUPABASE_URL       = "Project URL"   (e.g. https://abcd1234.supabase.co)
       • SUPABASE_ANON_KEY  = the "anon / public" key   (safe to ship in the app)

   Leave them empty to keep running fully offline (browser-only) like before.
---------------------------------------------------------------------------- */
window.HOC_CONFIG = {
  SUPABASE_URL: "https://wbgtchvyuhwnhbzsumpn.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Gq94rEU04A8lYMg-d76QoQ_cbZnULQ3",
  LOGO_BUCKET: "branding",  // public Storage bucket that holds the shared logo

  /* Subscription checkout. Paste a Stripe Payment Link (or other hosted checkout) URL here.
     Leave empty to let new sign-ups start a free trial until billing is connected. */
  SUBSCRIBE_URL: "",

  /* Square (marketplace checkout — Phase 3).
     - SQUARE_APP_ID and SQUARE_LOCATION_ID are PUBLIC (used by the in-page card form). Safe to ship.
     - The Square ACCESS TOKEN is a SECRET and must NEVER go here. It lives only as a
       Supabase Edge Function secret named SQUARE_ACCESS_TOKEN.
     - Use "sandbox" while testing, then switch to "production" with live values. */
  SQUARE_ENV: "production",
  SQUARE_APP_ID: "sq0idp-hSteLh91oEfx5DG7Lkpoyw",
  SQUARE_LOCATION_ID: "LCF26XCHA5M03",   // House of Cards (Main), 7050 Jefferson St

  /* Web Push (app notifications). Public VAPID key only — safe to ship.
     The matching PRIVATE key lives only as a Supabase Edge Function secret (VAPID_PRIVATE). */
  VAPID_PUBLIC: "BBB0LbkZgmMqssDZq5kjI5_UFD_5PjBvQUwt-lKx8zRs3TAOjXF5WCL2Jhic732hZAl53OtUTdhiPei_DcSC8Jc",

  /* Stripe Connect (third-party seller payments). Publishable key only — safe to ship.
     Secret key lives only as a Supabase Edge Function secret (STRIPE_SECRET_KEY).
     LIVE mode. (Checkout is hosted by Stripe and created server-side, so what actually
     controls live vs test is the STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET secrets in Supabase.)
     Test publishable key (for reference): pk_test_51TkzbXITh3Oog0PeUuBkbbQytC1lxVk89aP5gzLesb8VazpmO8kuE9ytRwMy3oQM729Wfa6OEoVVUOPoWVMiuPBE00PRbOVcPp */
  STRIPE_ENV: "live",
  STRIPE_PUBLISHABLE_KEY: "pk_live_51TkzbXITh3Oog0PeUEriBuNXA37HTLJIzjmGK9DMFm6JWWRLLycmTHD6lQnYnHg0LeBbmfWInHULT74WoM7ut7kp00fKXvdyH1"
};
