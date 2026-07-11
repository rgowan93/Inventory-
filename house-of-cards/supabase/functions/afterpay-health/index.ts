import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });
const SQV = "2025-01-23";
// Afterpay is accepted through Square for US merchants, so this verifies the Square link works.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch { /* allow empty */ }
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);
  const token = (Deno.env.get("SQUARE_ACCESS_TOKEN") || "").trim();
  const env = (Deno.env.get("SQUARE_ENV") || "").trim().toLowerCase() || "production";
  const location = (Deno.env.get("SQUARE_LOCATION_ID") || "").trim();
  const base = env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  if (!token) return json({ ok: false, env, error: "Square access token not set." });
  if (!location) return json({ ok: false, env, error: "Square location id not set." });
  try {
    const r = await fetch(base + "/v2/locations/" + encodeURIComponent(location), { headers: { "Authorization": "Bearer " + token, "Square-Version": SQV } });
    const j = await r.json();
    if (!r.ok) return json({ ok: false, env, status: r.status, error: (j?.errors?.[0]?.detail || "Square rejected the token.") });
    const loc = j?.location;
    return json({ ok: true, env: env + " (via Square)", merchant_id_tail: (loc?.name || location) + (loc?.status ? " · " + loc.status : ""), note: "Ensure Afterpay is turned on in Square Dashboard → Payments." });
  } catch (e) { return json({ ok: false, env, error: "Could not reach Square.", detail: String(e) }); }
});
