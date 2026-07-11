import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
function apCfg() {
  const mid = (Deno.env.get("AFTERPAY_MERCHANT_ID") || "").trim();
  const sk = (Deno.env.get("AFTERPAY_SECRET_KEY") || "").trim();
  const env = (Deno.env.get("AFTERPAY_ENV") || "").trim().toLowerCase();
  const base = env === "production" ? "https://api.us.afterpay.com" : "https://api-sandbox.us.afterpay.com";
  return { mid, sk, env: env || "sandbox", base, auth: "Basic " + btoa(mid + ":" + sk) };
}
const UA = "HouseOfCards/1.0 (Afterpay Pay-at-Show)";

// Owner-only Afterpay refund. Requires staff auth AND username === "reggie".
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);
  if (String(b?.p_user || "").trim().toLowerCase() !== "reggie") return json({ ok: false, error: "Owner only." }, 403);

  const id = Number(b?.sale_id); if (!id) return json({ ok: false, error: "Missing sale." }, 400);
  const { data: row } = await admin.from("afterpay_sales").select("id, amount_cents, refunded_cents, status, afterpay_payment_id, merchant_reference").eq("id", id).maybeSingle();
  if (!row) return json({ ok: false, error: "Sale not found." }, 404);
  if (row.status !== "captured") return json({ ok: false, error: "Only captured sales can be refunded." }, 409);
  if (!row.afterpay_payment_id) return json({ ok: false, error: "No Afterpay payment id on this sale." }, 409);
  const remaining = Math.max(0, (row.amount_cents || 0) - (row.refunded_cents || 0));
  if (remaining <= 0) return json({ ok: false, error: "Already fully refunded." }, 409);
  let cents = b?.amount_cents != null ? Math.round(Number(b.amount_cents)) : remaining;
  if (!(cents > 0)) return json({ ok: false, error: "Invalid amount." }, 400);
  if (cents > remaining) cents = remaining;

  const cfg = apCfg();
  if (!cfg.mid || !cfg.sk) return json({ ok: false, error: "Afterpay not configured." }, 200);
  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/payments/" + encodeURIComponent(row.afterpay_payment_id) + "/refund", {
      method: "POST", headers: { "Authorization": cfg.auth, "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ amount: { amount: (cents / 100).toFixed(2), currency: "USD" }, merchantReference: (row.merchant_reference || ("HOC-AP-" + id)) + "-refund", refundMerchantReference: "R-" + id + "-" + Date.now() })
    });
    out = await r.json();
    if (!r.ok) return json({ ok: false, error: (out?.message || out?.errorCode || "Afterpay refund failed."), status: r.status }, 200);
  } catch (e) { return json({ ok: false, error: "Could not reach Afterpay.", detail: String(e) }, 200); }

  const newRefunded = (row.refunded_cents || 0) + cents;
  const fully = newRefunded >= (row.amount_cents || 0);
  await admin.from("afterpay_sales").update({ refunded_cents: newRefunded, status: fully ? "refunded" : row.status, refunded_at: new Date().toISOString() }).eq("id", id);
  return json({ ok: true, refunded_cents: newRefunded, fully });
});
