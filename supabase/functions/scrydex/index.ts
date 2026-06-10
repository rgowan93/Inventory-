// Supabase Edge Function: scrydex
// Secure passthrough to the Scrydex Pokémon API. Keeps your paid credentials
// (X-Api-Key + X-Team-ID) on the server — they are never exposed to the browser.
//
// Deploy (Supabase Dashboard → Edge Functions → Deploy a new function):
//   • Name it exactly:  scrydex
//   • Paste this file
//   • Turn OFF "Verify JWT"
//   • Add two secrets:
//       SCRYDEX_API_KEY = <your Scrydex API key>
//       SCRYDEX_TEAM_ID = <your Scrydex Team ID>
//
// Usage from the app:  /functions/v1/scrydex?path=cards&q=name:"Greninja" number:22&include=prices
// It forwards GET requests to https://api.scrydex.com/pokemon/v1/<path>?<query>
// with the secret headers attached. Only GETs to that host are allowed.

const BASE = "https://api.scrydex.com/pokemon/v1/";
const API_KEY = Deno.env.get("SCRYDEX_API_KEY") || "";
const TEAM_ID = Deno.env.get("SCRYDEX_TEAM_ID") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!API_KEY || !TEAM_ID) {
    return new Response(JSON.stringify({ error: "Scrydex secrets not set (SCRYDEX_API_KEY / SCRYDEX_TEAM_ID)" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  try {
    const u = new URL(req.url);
    let path = (u.searchParams.get("path") || "cards").replace(/^\/+/, "").replace(/\.\.+/g, "");
    u.searchParams.delete("path");
    const qs = u.searchParams.toString();
    const target = BASE + path + (qs ? ("?" + qs) : "");
    const r = await fetch(target, { headers: { "X-Api-Key": API_KEY, "X-Team-ID": TEAM_ID, "Accept": "application/json" } });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
