// Liest einen Kassenbon per KI und gibt Händler, Datum, Summe und Positionen als JSON zurück.
// Anbieter: Perplexity (Variable PERPLEXITY_API_KEY) oder Claude (Variable ANTHROPIC_API_KEY).
// Optional: BELEG_PROVIDER = perplexity oder anthropic, BELEG_MODEL = Modellname (Standard bei Perplexity: sonar-pro).
// Standard: Perplexity, wenn PERPLEXITY_API_KEY gesetzt ist, sonst Claude.

const makePrompt = () => `Heutiges Datum: ${new Date().toISOString().slice(0, 10)}.
Du liest ein Foto oder einen Screenshot mit Kassenbons, Rechnungen oder Kontobuchungen aus einer Banking App. Nutze keine Websuche, lies nur das Bild. Antworte ausschließlich mit einem JSON Objekt, ohne Markdown und ohne Erklärung, in genau dieser Form:
{"belege":[{"haendler":"kurzer Name","datum":"YYYY-MM-DD","gesamt":0.00,"positionen":[{"name":"Artikel","preis":0.00}]}]}
Regeln:
- Jeder voneinander getrennte Beleg oder jede einzelne Kontobuchung ist ein eigener Eintrag in belege. Ein einzelner Kassenbon mit vielen Artikeln ist genau ein Eintrag mit mehreren positionen.
- Zeigt das Bild zum Beispiel eine Liste von Lastschriften, gib für jede Zeile einen Eintrag mit haendler, datum und gesamt, und lass positionen leer.
- Beträge als Zahl in Euro mit Punkt als Dezimaltrenner. gesamt immer als positive Zahl, auch wenn auf dem Bild ein Minus steht.
- positionen enthält nur Artikelzeilen mit ihrem Endpreis (Menge mal Einzelpreis schon verrechnet). Keine Summenzeile, keine MwSt, keine Zahlungsart.
- Rabatte, Gutscheine und Pfandrückgaben als eigene Position mit negativem Preis.
- Ist das Datum nicht lesbar, setze datum auf einen leeren Text. Fehlt im Datum das Jahr, nimm das Jahr aus dem heutigen Datum, ohne ein Datum in der Zukunft zu erzeugen.
- Ist etwas nicht lesbar, lasse es weg und rate nicht.`;

function withTimeout(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

async function viaPerplexity(img, mediaType) {
  const to = withTimeout(9000);
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    signal: to.signal,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.PERPLEXITY_API_KEY },
    body: JSON.stringify({
      model: process.env.BELEG_MODEL || "sonar-pro",
      temperature: 0,
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: makePrompt() },
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${img}` } }
        ]
      }]
    })
  });
  const j = await r.json();
  to.done();
  if (!r.ok) throw Object.assign(new Error("Perplexity Fehler"), { detail: (j && (j.error && (j.error.message || j.error))) || r.status });
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

async function viaClaude(img, mediaType) {
  const to = withTimeout(9000);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    signal: to.signal,
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.BELEG_MODEL || "claude-haiku-5-5",
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: img } },
          { type: "text", text: makePrompt() }
        ]
      }]
    })
  });
  const j = await r.json();
  to.done();
  if (!r.ok) throw Object.assign(new Error("Claude Fehler"), { detail: (j && j.error && j.error.message) || r.status });
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST erforderlich" });

  const provider = process.env.BELEG_PROVIDER || (process.env.PERPLEXITY_API_KEY ? "perplexity" : "anthropic");
  if (provider === "perplexity" && !process.env.PERPLEXITY_API_KEY) return reply(500, { error: "PERPLEXITY_API_KEY fehlt" });
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) return reply(500, { error: "ANTHROPIC_API_KEY fehlt" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Ungültige Anfrage" }); }
  const img = body.image;
  if (!img || typeof img !== "string" || img.length > 7000000) return reply(400, { error: "Bild fehlt oder ist zu groß" });
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType) ? body.mediaType : "image/jpeg";

  try {
    const text = provider === "perplexity" ? await viaPerplexity(img, mediaType) : await viaClaude(img, mediaType);
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return reply(502, { error: "Keine Antwort lesbar" });
    const d = JSON.parse(text.slice(start, end + 1));
    const rohe = Array.isArray(d.belege) && d.belege.length ? d.belege : [d];
    const belege = rohe.slice(0, 20).map((b) => ({
      haendler: String((b && b.haendler) || "").slice(0, 60),
      datum: /^\d{4}-\d{2}-\d{2}$/.test((b && b.datum) || "") ? b.datum : "",
      gesamt: isFinite(Number(b && b.gesamt)) ? Math.abs(Number(b.gesamt)) : 0,
      positionen: (Array.isArray(b && b.positionen) ? b.positionen : [])
        .map((p) => ({ name: String((p && p.name) || "").slice(0, 80), preis: Number(p && p.preis) }))
        .filter((p) => p.name && isFinite(p.preis))
    })).filter((b) => b.haendler || b.gesamt || b.positionen.length);
    return reply(200, { belege });
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return reply(timedOut ? 504 : 500, { error: "Beleg konnte nicht gelesen werden", detail: timedOut ? "Zeitüberschreitung, die KI war zu langsam" : (e.detail || String(e.message || e)) });
  }
};
