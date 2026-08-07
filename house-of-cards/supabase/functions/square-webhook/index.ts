import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
// Square webhook -> confirms Afterpay (and card) payments server-side and notifies staff,
// even if the customer never returns to the site after paying.
// Security: every request MUST carry a valid Square HMAC-SHA256 signature. Without this,
// anyone could forge a "payment completed" event and walk off with an item.
const VAPID_PUBLIC_DEFAULT = "BBB0LbkZgmMqssDZq5kjI5_UFD_5PjBvQUwt-lKx8zRs3TAOjXF5WCL2Jhic732hZAl53OtUTdhiPei_DcSC8Jc";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const money = (c: number) => "$" + ((c || 0) / 100).toFixed(2);

function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmacB64(key: string, msg: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const sigKey = (Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY") || "").trim();
  if (!sigKey) return json({ ok: false, error: "Webhook signature key not configured." }, 500);

  const raw = await req.text();
  const sig = req.headers.get("x-square-hmacsha256-signature") || "";
  if (!sig) return json({ ok: false, error: "Missing signature." }, 401);

  // Square signs (notificationUrl + body). Accept the configured URL, plus the request URL
  // with and without its query string, so a trailing ?apikey= can't break verification.
  const reqUrl = req.url;
  const noQuery = reqUrl.split("?")[0];
  const configured = (Deno.env.get("SQUARE_WEBHOOK_URL") || "").trim();
  const candidates = [configured, reqUrl, noQuery].filter(Boolean);
  let verified = false;
  for (const url of candidates) {
    try { if (safeEq(await hmacB64(sigKey, url + raw), sig)) { verified = true; break; } } catch (_) {}
  }
  if (!verified) return json({ ok: false, error: "Bad signature." }, 401);

  let evt: any; try { evt = JSON.parse(raw); } catch { return json({ ok: true, ignored: "bad json" }); }
  const type = String(evt?.type || "");
  if (type !== "payment.created" && type !== "payment.updated") return json({ ok: true, ignored: type });

  const payment = evt?.data?.object?.payment;
  if (!payment) return json({ ok: true, ignored: "no payment" });
  if (String(payment.status || "").toUpperCase() !== "COMPLETED") return json({ ok: true, ignored: "not completed" });

  const orderId = String(payment.order_id || "");
  if (!orderId) return json({ ok: true, ignored: "no order id" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await admin.from("afterpay_sales").select("id, amount_cents, label, status").eq("afterpay_order_id", orderId).maybeSingle();
  if (!row) return json({ ok: true, ignored: "not one of ours" });          // a normal Square/POS sale
  if (row.status === "captured" || row.status === "refunded") return json({ ok: true, already: true }); // idempotent

  const paidCents = Number(payment?.amount_money?.amount || 0);
  if (paidCents < (row.amount_cents || 0)) {
    await admin.from("afterpay_sales").update({ status: "declined", decline_reason: "Underpaid: got " + money(paidCents) + " of " + money(row.amount_cents) }).eq("id", row.id);
    try { await pushStaff(admin, "Afterpay underpaid ⚠️", money(paidCents) + " received of " + money(row.amount_cents) + (row.label ? (" · " + row.label) : "") + " — do not release the item."); } catch (_) {}
    return json({ ok: true, underpaid: true });
  }

  await admin.from("afterpay_sales").update({ status: "captured", afterpay_payment_id: String(payment.id || ""), captured_at: new Date().toISOString() }).eq("id", row.id);
  try {
    await pushStaff(admin, "Afterpay approved ✅", money(row.amount_cents) + (row.label ? (" · " + row.label) : "") + " — payment received. Safe to hand over.");
  } catch (_) {}
  return json({ ok: true, captured: true });
});
