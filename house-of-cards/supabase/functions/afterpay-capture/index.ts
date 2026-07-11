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
// Confirm the Square order behind this payment link actually got paid.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const token = String(b?.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing token." }, 400);
  const { data: row } = await admin.from("afterpay_sales").select("id, amount_cents, label, status, customer_name, customer_contact, afterpay_order_id").eq("token", token).maybeSingle();
  if (!row) return json({ ok: false, error: "Unknown or expired sale." }, 404);
  if (row.status === "captured") return json({ ok: true, already: true, amount_cents: row.amount_cents, label: row.label, id: row.id, customer_name: row.customer_name, customer_contact: row.customer_contact });
  if (!row.afterpay_order_id) return json({ ok: false, error: "No Square order on this sale." }, 409);
  const cfg = sqCfg();
  if (!cfg.token) return json({ ok: false, error: "Square not configured." }, 200);
  let out: any;
  try {
    const r = await fetch(cfg.base + "/v2/orders/" + encodeURIComponent(row.afterpay_order_id), { headers: { "Authorization": "Bearer " + cfg.token, "Square-Version": SQV } });
    out = await r.json();
    if (!r.ok) return json({ ok: false, error: (out?.errors?.[0]?.detail || "Could not check the order."), status: r.status }, 200);
  } catch (e) { return json({ ok: false, error: "Could not reach Square.", detail: String(e) }, 200); }
  const order = out?.order || {};
  const tenders = order.tenders || [];
  const paid = order.state === "COMPLETED" || tenders.length > 0 || (order.net_amount_due_money && order.net_amount_due_money.amount === 0);
  if (!paid) return json({ ok: false, error: "Payment not completed yet.", state: order.state || "OPEN" }, 200);
  const paymentId = tenders?.[0]?.payment_id || tenders?.[0]?.id || "";
  await admin.from("afterpay_sales").update({ status: "captured", afterpay_payment_id: String(paymentId), captured_at: new Date().toISOString() }).eq("id", row.id);
  return json({ ok: true, amount_cents: row.amount_cents, label: row.label, id: row.id, payment_id: paymentId || null, customer_name: row.customer_name, customer_contact: row.customer_contact });
});
