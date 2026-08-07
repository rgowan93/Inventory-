import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
// Confirms the Square order behind a customer-started Afterpay sale, then pushes the
// result (approved / not completed) to every staff device so they know whether to
// hand over the item.
const VAPID_PUBLIC_DEFAULT = "BBB0LbkZgmMqssDZq5kjI5_UFD_5PjBvQUwt-lKx8zRs3TAOjXF5WCL2Jhic732hZAl53OtUTdhiPei_DcSC8Jc";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
const SQV = "2025-01-23";
const money = (c: number) => "$" + ((c || 0) / 100).toFixed(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sqCfg() {
  const token = (Deno.env.get("SQUARE_ACCESS_TOKEN") || "").trim();
  const env = (Deno.env.get("SQUARE_ENV") || "").trim().toLowerCase();
  const base = env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  return { token, env: env || "production", base };
}

async function pushStaff(admin: any, title: string, body: string) {
  const priv = Deno.env.get("VAPID_PRIVATE") || "";
  const pub = Deno.env.get("VAPID_PUBLIC") || VAPID_PUBLIC_DEFAULT;
  if (!priv) return;
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint,p256dh,auth").eq("audience", "staff");
  if (!subs || !subs.length) return;
  try { webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:scrapboys1993@gmail.com", pub, priv); } catch { return; }
  const payload = JSON.stringify({ title, body, url: "./" });
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (_) {}
  }
}

async function orderPaid(cfg: any, orderId: string) {
  const r = await fetch(cfg.base + "/v2/orders/" + encodeURIComponent(orderId), { headers: { "Authorization": "Bearer " + cfg.token, "Square-Version": SQV } });
  const out = await r.json();
  if (!r.ok) return { ok: false, err: out?.errors?.[0]?.detail || "Could not check the order." };
  const order = out?.order || {};
  const tenders = order.tenders || [];
  const paid = order.state === "COMPLETED" || tenders.length > 0 || (order.net_amount_due_money && order.net_amount_due_money.amount === 0);
  return { ok: true, paid, paymentId: tenders?.[0]?.payment_id || tenders?.[0]?.id || "", state: order.state || "OPEN" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const token = String(b?.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing token." }, 400);

  const { data: row } = await admin.from("afterpay_sales").select("id, amount_cents, label, status, afterpay_order_id").eq("token", token).maybeSingle();
  if (!row) return json({ ok: false, error: "Unknown or expired sale." }, 404);
  if (row.status === "captured") return json({ ok: true, already: true, amount_cents: row.amount_cents, label: row.label, id: row.id });
  if (!row.afterpay_order_id) return json({ ok: false, error: "No Square order on this sale." }, 409);

  const cfg = sqCfg();
  if (!cfg.token) return json({ ok: false, error: "Payments are not set up yet." }, 200);

  // Square can lag a beat between redirect and the order showing as paid — retry briefly.
  let res: any = null;
  for (const wait of [0, 1500, 3000]) {
    if (wait) await sleep(wait);
    try { res = await orderPaid(cfg, row.afterpay_order_id); } catch (e) { res = { ok: false, err: String(e) }; }
    if (res.ok && res.paid) break;
  }
  if (!res || !res.ok) return json({ ok: false, error: (res && res.err) || "Could not reach the payment service." }, 200);

  const desc = money(row.amount_cents) + (row.label ? (" · " + row.label) : "");
  if (!res.paid) {
    await admin.from("afterpay_sales").update({ status: "declined", decline_reason: "Not completed at return (" + res.state + ")" }).eq("id", row.id);
    try { await pushStaff(admin, "Afterpay NOT completed ❌", desc + " — payment did not go through. Do not release the item."); } catch (_) {}
    return json({ ok: false, error: "Payment was not completed.", state: res.state }, 200);
  }

  await admin.from("afterpay_sales").update({ status: "captured", afterpay_payment_id: String(res.paymentId || ""), captured_at: new Date().toISOString() }).eq("id", row.id);
  try { await pushStaff(admin, "Afterpay approved ✅", desc + " — payment received. Safe to hand over."); } catch (_) {}
  return json({ ok: true, amount_cents: row.amount_cents, label: row.label, id: row.id, payment_id: res.paymentId || null });
});
