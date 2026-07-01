import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
function apCfg() {
  const mid = (Deno.env.get("AFTERPAY_MERCHANT_ID") || "").trim();
  const sk = (Deno.env.get("AFTERPAY_SECRET_KEY") || "").trim();
  const env = (Deno.env.get("AFTERPAY_ENV") || "").trim().toLowerCase();
  const base = env === "production" ? "https://global-api.afterpay.com" : "https://global-api-sandbox.afterpay.com";
  return { mid, sk, env: env || "sandbox", base, auth: "Basic " + btoa(mid + ":" + sk) };
}
const UA = "HouseOfCards/1.0 (Afterpay Pay-at-Show)";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);

  const cfg = apCfg();
  if (!cfg.mid || !cfg.sk) return json({ ok: false, error: "Afterpay not configured. Set AFTERPAY_MERCHANT_ID and AFTERPAY_SECRET_KEY." }, 200);

  const cents = Math.round(Number(b?.amount_cents || 0));
  if (!(cents > 0)) return json({ ok: false, error: "Enter an amount." }, 400);
  const label = String(b?.label || "In-person sale").slice(0, 120);
  const origin = String(b?.origin || "").split("#")[0].split("?")[0].replace(/\/$/, "");
  if (!/^https:\/\//.test(origin)) return json({ ok: false, error: "Bad return URL." }, 400);
  const ref = "HOC-AP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const custName = String(b?.customer_name || "").slice(0, 80);
  const custContact = String(b?.customer_contact || "").slice(0, 80);

  const consumer: any = {};
  if (custName) { const parts = custName.split(/\s+/); consumer.givenNames = parts[0] || custName; if (parts.length > 1) consumer.surname = parts.slice(1).join(" "); }
  if (/^\S+@\S+\.\S+$/.test(custContact)) consumer.email = custContact;
  else if (custContact.replace(/\D/g, "").length >= 10) consumer.phoneNumber = custContact.replace(/\D/g, "").slice(-10);

  const payload: any = {
    amount: { amount: (cents / 100).toFixed(2), currency: "USD" },
    merchant: { redirectConfirmUrl: origin + "/?afterpay=return", redirectCancelUrl: origin + "/?afterpay=cancel" },
    merchantReference: ref,
    mode: "standard",
    items: [{ name: label, quantity: 1, price: { amount: (cents / 100).toFixed(2), currency: "USD" } }]
  };
  if (Object.keys(consumer).length) payload.consumer = consumer;

  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/checkouts", { method: "POST", headers: { "Authorization": cfg.auth, "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify(payload) });
    out = await r.json();
    if (!r.ok) return json({ ok: false, error: (out?.message || out?.errorCode || "Afterpay could not start this sale."), status: r.status, env: cfg.env }, 200);
  } catch (e) { return json({ ok: false, error: "Could not reach Afterpay.", detail: String(e) }, 200); }

  const token = out?.token; const url = out?.redirectCheckoutUrl;
  if (!token || !url) return json({ ok: false, error: "Afterpay did not return a checkout.", env: cfg.env }, 200);
  await admin.from("afterpay_sales").insert({ token, merchant_reference: ref, amount_cents: cents, label, photo_url: b?.photo_url || null, staff_user: String(b?.p_user || ""), customer_name: custName || null, customer_contact: custContact || null, status: "pending" });
  return json({ ok: true, token, url, env: cfg.env });
});
