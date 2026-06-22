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
  SQUARE_ENV: "sandbox",
  SQUARE_APP_ID: "sandbox-sq0idb-tXgXopZO7RcUCNTI__pvjg",
  SQUARE_LOCATION_ID: "L6KBN4VHSHK29"   // Sandbox Default Test Account (Main)
};
