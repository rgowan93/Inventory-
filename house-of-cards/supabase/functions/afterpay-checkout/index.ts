import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// Customer-initiated Afterpay sale. The buyer enters the amount + item on their OWN phone
// at houseofcardsftwalton.com, then pays via a Square checkout link with Afterpay enabled.
// Public endpoint (no staff login) -> guarded by amount bounds + per-IP rate limit.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
const SQV = "2025-01-23";
const MIN_CENTS = 100;      // $1 — Afterpay minimum
const MAX_CENTS = 200000;   // $2,000 — Afterpay in-person cap
const MAX_PER_IP_PER_HOUR = 8;
function sqCfg() {
  const token = (Deno.env.get("SQUARE_ACCESS_TOKEN") || "").trim();
  const env = (Deno.env.get("SQUARE_ENV") || "").trim().toLowerCase();
  const base = env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const location = (Deno.env.get("SQUARE_LOCATION_ID") || "").trim();
  return { token, env: env || "production", base, location };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }

  const cfg = sqCfg();
  if (!cfg.token) return json({ ok: false, error: "Payments are not set up yet." }, 200);
  if (!cfg.location) return json({ ok: false, error: "Payments are not set up yet." }, 200);

  const cents = Math.round(Number(b?.amount_cents || 0));
  if (!(cents > 0)) return json({ ok: false, error: "Enter an amount." }, 400);
  if (cents < MIN_CENTS) return json({ ok: false, error: "Afterpay needs a total of at least $1." }, 400);
  if (cents > MAX_CENTS) return json({ ok: false, error: "Afterpay tops out at $2,000. Please ask a team member for another way to pay." }, 400);

  const label = String(b?.label || "").trim().slice(0, 200) || "In-person sale";
  const origin = String(b?.origin || "").split("#")[0].split("?")[0].replace(/\/$/, "");
  if (!/^https:\/\//.test(origin)) return json({ ok: false, error: "Bad return URL." }, 400);

  // per-IP rate limit
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  try {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("afterpay_sales").select("id", { count: "exact", head: true }).eq("client_ip", ip).gte("created_at", since);
    if ((count || 0) >= MAX_PER_IP_PER_HOUR) return json({ ok: false, error: "Too many attempts. Please wait a few minutes or ask a team member for help." }, 429);
  } catch (_) { /* never block a real sale on the limiter */ }

  const ref = "HOC-AP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const payload: any = {
    idempotency_key: ref,
    quick_pay: { name: label, price_money: { amount: cents, currency: "USD" }, location_id: cfg.location },
    checkout_options: {
      accepted_payment_methods: { afterpay_clearpay: true, card: true, google_pay: true, apple_pay: true, cash_app_pay: true },
      redirect_url: origin + "/?afterpay=return",
      ask_for_shipping_address: false
    }
  };

  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/online-checkout/payment-links", { method: "POST", headers: { "Authorization": "Bearer " + cfg.token, "Square-Version": SQV, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    out = await r.json();
    if (!r.ok) return json({ ok: false, error: (out?.errors?.[0]?.detail || "Could not start the checkout."), status: r.status }, 200);
  } catch (e) { return json({ ok: false, error: "Could not reach the payment service.", detail: String(e) }, 200); }

  const pl = out?.payment_link;
  if (!pl?.id || !pl?.url) return json({ ok: false, error: "Could not start the checkout." }, 200);
  await admin.from("afterpay_sales").insert({ token: pl.id, merchant_reference: ref, amount_cents: cents, label, photo_url: b?.photo_url || null, staff_user: null, customer_name: null, customer_contact: null, status: "pending", afterpay_order_id: pl.order_id || null, client_ip: ip });
  return json({ ok: true, token: pl.id, url: pl.url, env: cfg.env });
});
