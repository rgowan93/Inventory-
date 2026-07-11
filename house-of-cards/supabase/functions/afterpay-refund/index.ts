import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
const SQV = "2025-01-23";
function sqCfg() {
  const token = (Deno.env.get("SQUARE_ACCESS_TOKEN") || "").trim();
  const env = (Deno.env.get("SQUARE_ENV") || "").trim().toLowerCase();
  const base = env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  return { token, env: env || "production", base };
}
// Owner-only (reggie) Square refund on an Afterpay-via-Square sale.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);
  if (String(b?.p_user || "").trim().toLowerCase() !== "reggie") return json({ ok: false, error: "Owner only." }, 403);
  const id = Number(b?.sale_id); if (!id) return json({ ok: false, error: "Missing sale." }, 400);
  const { data: row } = await admin.from("afterpay_sales").select("id, amount_cents, refunded_cents, status, afterpay_payment_id").eq("id", id).maybeSingle();
  if (!row) return json({ ok: false, error: "Sale not found." }, 404);
  if (row.status !== "captured") return json({ ok: false, error: "Only captured sales can be refunded." }, 409);
  if (!row.afterpay_payment_id) return json({ ok: false, error: "No Square payment id on this sale." }, 409);
  const remaining = Math.max(0, (row.amount_cents || 0) - (row.refunded_cents || 0));
  if (remaining <= 0) return json({ ok: false, error: "Already fully refunded." }, 409);
  let cents = b?.amount_cents != null ? Math.round(Number(b.amount_cents)) : remaining;
  if (!(cents > 0)) return json({ ok: false, error: "Invalid amount." }, 400);
  if (cents > remaining) cents = remaining;
  const cfg = sqCfg();
  if (!cfg.token) return json({ ok: false, error: "Square not configured." }, 200);
  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/refunds", { method: "POST", headers: { "Authorization": "Bearer " + cfg.token, "Square-Version": SQV, "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: ("apr-" + id + "-" + cents + "-" + (row.refunded_cents || 0)).slice(0, 45), payment_id: row.afterpay_payment_id, amount_money: { amount: cents, currency: "USD" }, reason: "Afterpay sale refund" }) });
    out = await r.json();
    if (!r.ok) return json({ ok: false, error: (out?.errors?.[0]?.detail || "Square refund failed."), status: r.status }, 200);
  } catch (e) { return json({ ok: false, error: "Could not reach Square.", detail: String(e) }, 200); }
  const newRefunded = (row.refunded_cents || 0) + cents;
  const fully = newRefunded >= (row.amount_cents || 0);
  await admin.from("afterpay_sales").update({ refunded_cents: newRefunded, status: fully ? "refunded" : row.status, refunded_at: new Date().toISOString() }).eq("id", id);
  return json({ ok: true, refunded_cents: newRefunded, fully });
});
