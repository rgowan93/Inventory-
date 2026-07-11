import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// Afterpay for US merchants runs through Square: this creates a Square Payment Link
// with Afterpay enabled. The customer opens it and pays; funds settle to Square.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
const SQV = "2025-01-23";
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
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);
  const cfg = sqCfg();
  if (!cfg.token) return json({ ok: false, error: "Square not configured." }, 200);
  if (!cfg.location) return json({ ok: false, error: "Square location not set." }, 200);
  const cents = Math.round(Number(b?.amount_cents || 0));
  if (!(cents > 0)) return json({ ok: false, error: "Enter an amount." }, 400);
  const label = String(b?.label || "In-person sale").slice(0, 200);
  const origin = String(b?.origin || "").split("#")[0].split("?")[0].replace(/\/$/, "");
  if (!/^https:\/\//.test(origin)) return json({ ok: false, error: "Bad return URL." }, 400);
  const ref = "HOC-AP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const custName = String(b?.customer_name || "").slice(0, 80);
  const custContact = String(b?.customer_contact || "").slice(0, 80);
  const pre: any = {};
  if (/^\S+@\S+\.\S+$/.test(custContact)) pre.buyer_email = custContact;
  else if (custContact.replace(/\D/g, "").length >= 10) pre.buyer_phone_number = custContact.replace(/[^0-9+]/g, "");
  const payload: any = {
    idempotency_key: ref,
    quick_pay: { name: label, price_money: { amount: cents, currency: "USD" }, location_id: cfg.location },
    checkout_options: {
      accepted_payment_methods: { afterpay_clearpay: true, card: true, google_pay: true, apple_pay: true, cash_app_pay: true },
      redirect_url: origin + "/?afterpay=return",
      ask_for_shipping_address: false
    }
  };
  if (Object.keys(pre).length) payload.pre_populated_data = pre;
  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/online-checkout/payment-links", { method: "POST", headers: { "Authorization": "Bearer " + cfg.token, "Square-Version": SQV, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    out = await r.json();
    if (!r.ok) return json({ ok: false, error: (out?.errors?.[0]?.detail || "Square could not create the checkout."), status: r.status }, 200);
  } catch (e) { return json({ ok: false, error: "Could not reach Square.", detail: String(e) }, 200); }
  const pl = out?.payment_link;
  if (!pl?.id || !pl?.url) return json({ ok: false, error: "Square did not return a checkout link." }, 200);
  await admin.from("afterpay_sales").insert({ token: pl.id, merchant_reference: ref, amount_cents: cents, label, photo_url: b?.photo_url || null, staff_user: String(b?.p_user || ""), customer_name: custName || null, customer_contact: custContact || null, status: "pending", afterpay_order_id: pl.order_id || null });
  return json({ ok: true, token: pl.id, url: pl.url, env: cfg.env });
});
