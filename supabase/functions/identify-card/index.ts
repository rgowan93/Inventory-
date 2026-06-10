// Supabase Edge Function: identify-card
// Reads a trading-card photo with Claude vision and returns the card's name,
// collector number, set total, and set name. The Anthropic API key stays here
// on the server (set it as a secret: ANTHROPIC_API_KEY) and is never exposed
// to the browser.
//
// Deploy (Supabase Dashboard → Edge Functions → Deploy a new function):
//   • Name the function exactly:  identify-card
//   • Paste this file as the code
//   • Turn OFF "Verify JWT" (simplest for a personal app)
//   • Add a secret:  ANTHROPIC_API_KEY = <your Anthropic key>
//
// Cost: ~1-2 cents per scan on claude-opus-4-8. To cut cost ~5x, change the
// model below to "claude-haiku-4-5" (still far better than the old OCR).

import Anthropic from "npm:@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { image } = await req.json();
    let data = String(image || "");
    let media = "image/jpeg";
    const m = data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
    if (m) { media = m[1]; data = m[2]; }
    if (!data) {
      return new Response(JSON.stringify({ error: "no image" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const resp = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 400,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },        // printed card name, e.g. "Mega Greninja ex"
              number: { type: "string" },        // left part of the collector number, e.g. "22"
              setTotal: { type: "integer" },     // right part, e.g. 68 from "022/068" (0 if unreadable)
              setName: { type: "string" },       // set name if visible, else ""
              isPokemon: { type: "boolean" },
            },
            required: ["name", "number", "setTotal", "setName", "isPokemon"],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media, data } },
          { type: "text", text:
            'This is a photo of a trading card (usually Pokémon). Identify it. Return:\n' +
            '- name: the printed card name exactly, e.g. "Mega Greninja ex" or "Charizard ex"\n' +
            '- number: the left part of the collector number as printed, e.g. "22" from "022/068" (strip leading zeros)\n' +
            '- setTotal: the right part as an integer, e.g. 68 from "022/068" (use 0 if you cannot read it)\n' +
            '- setName: the set name if visible, otherwise ""\n' +
            '- isPokemon: true if it is a Pokémon card\n' +
            'Read carefully through foil glare and stylized fonts. If a field is unreadable, use "" or 0.' },
        ],
      }],
    });

    const text = (resp.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text || "{}";
    return new Response(text, { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
