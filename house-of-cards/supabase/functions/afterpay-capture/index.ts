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

// Capture is authorized by the unguessable Afterpay order token, which must match a
// 'pending' sale WE created in afterpay-checkout. No staff password needed here because
// the phone has already been handed back after the consumer approved in Afterpay.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const token = String(b?.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing token." }, 400);

  const { data: row } = await admin.from("afterpay_sales").select("id, amount_cents, label, status, customer_name, customer_contact, merchant_reference").eq("token", token).maybeSingle();
  if (!row) return json({ ok: false, error: "Unknown or expired sale." }, 404);
  if (row.status === "captured") return json({ ok: true, already: true, amount_cents: row.amount_cents, label: row.label, id: row.id, customer_name: row.customer_name, customer_contact: row.customer_contact });
  if (row.status === "canceled") return json({ ok: false, error: "This sale was canceled." }, 409);

  const cfg = apCfg();
  if (!cfg.mid || !cfg.sk) return json({ ok: false, error: "Afterpay not configured." }, 200);

  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/payments/capture", { method: "POST", headers: { "Authorization": cfg.auth, "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ token, merchantReference: row.merchant_reference || undefined }) });
    out = await r.json();
    if (!r.ok) {
      const reason = out?.message || out?.errorCode || ("HTTP " + r.status);
      await admin.from("afterpay_sales").update({ status: "declined", decline_reason: String(reason).slice(0, 300) }).eq("id", row.id);
      return json({ ok: false, error: "Afterpay declined this payment.", reason, status: r.status }, 200);
    }
  } catch (e) { return json({ ok: false, error: "Could not reach Afterpay.", detail: String(e) }, 200); }

  const status = out?.status || out?.paymentState || "";
  const approved = status === "APPROVED" || status === "CAPTURED";
  if (!approved) {
    await admin.from("afterpay_sales").update({ status: "declined", decline_reason: String(status || "not approved").slice(0, 300) }).eq("id", row.id);
    return json({ ok: false, error: "Payment was not approved.", status }, 200);
  }
  await admin.from("afterpay_sales").update({ status: "captured", afterpay_payment_id: String(out?.id || ""), afterpay_order_id: String(out?.orderDetails?.id || out?.id || ""), captured_at: new Date().toISOString() }).eq("id", row.id);
  return json({ ok: true, amount_cents: row.amount_cents, label: row.label, id: row.id, payment_id: out?.id || null, customer_name: row.customer_name, customer_contact: row.customer_contact });
});
