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
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch { /* allow empty */ }
  const { data: ok } = await admin.rpc("staff_ok", { p_user: b?.p_user || "", p_pass: b?.p_pass || "" });
  if (ok !== true) return json({ ok: false, error: "Not authorized." }, 403);

  const cfg = apCfg();
  const mid_tail = cfg.mid ? ("…" + cfg.mid.slice(-4)) : "";
  if (!cfg.mid || !cfg.sk) return json({ ok: false, env: cfg.env, merchant_set: !!cfg.mid, secret_set: !!cfg.sk, error: "Afterpay secrets not set (AFTERPAY_MERCHANT_ID / AFTERPAY_SECRET_KEY)." });
  try {
    const r = await fetch(cfg.base + "/v2/configuration", { headers: { "Authorization": cfg.auth, "User-Agent": UA } });
    const out = await r.json();
    if (!r.ok) return json({ ok: false, env: cfg.env, merchant_id_tail: mid_tail, status: r.status, error: (out?.message || out?.errorCode || "Auth failed — check merchant id / secret / env.") });
    const min = out?.minimumAmount?.amount, max = out?.maximumAmount?.amount;
    return json({ ok: true, env: cfg.env, merchant_id_tail: mid_tail, minimum: min || null, maximum: max || null });
  } catch (e) { return json({ ok: false, env: cfg.env, merchant_id_tail: mid_tail, error: "Could not reach Afterpay.", detail: String(e) }); }
});
