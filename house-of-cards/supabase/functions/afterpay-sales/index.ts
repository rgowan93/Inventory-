import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

// Owner-only Afterpay dashboard. Requires valid staff auth AND username === "reggie".
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, error: "Bad body" }, 400); }
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);
  if (String(b?.p_user || "").trim().toLowerCase() !== "reggie") return json({ ok: false, error: "Owner only." }, 403);

  const { data: sales } = await admin.from("afterpay_sales").select("id, amount_cents, label, status, staff_user, customer_name, customer_contact, created_at, captured_at, decline_reason, photo_url").order("created_at", { ascending: false }).limit(300);
  const rows = sales || [];
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  let capturedCents = 0, capturedCount = 0, pending = 0, declined = 0, todayCents = 0;
  for (const r of rows) {
    if (r.status === "captured") { capturedCents += (r.amount_cents || 0); capturedCount++; if (r.captured_at && new Date(r.captured_at) >= startOfToday) todayCents += (r.amount_cents || 0); }
    else if (r.status === "pending") pending++;
    else if (r.status === "declined") declined++;
  }
  return json({ ok: true, sales: rows, totals: { captured_cents: capturedCents, captured_count: capturedCount, pending, declined, today_cents: todayCents } });
});
