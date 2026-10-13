// Liest einen Kassenbon per Claude Vision und gibt Händler, Datum, Summe und Positionen als JSON zurück.
// Benötigt in Netlify die Umgebungsvariable ANTHROPIC_API_KEY.
// Optional: BELEG_MODEL (Standard: claude-haiku-5-5, schneller; für genauere Ergebnisse z. B. claude-sonnet-5-5).

const PROMPT = `Du liest einen Kassenbon oder eine Rechnung auf dem Foto. Antworte ausschließlich mit einem JSON Objekt, ohne Markdown und ohne Erklärung, in genau dieser Form:
{"haendler":"kurzer Name des Geschäfts","datum":"YYYY-MM-DD","gesamt":0.00,"positionen":[{"name":"Artikel","preis":0.00}]}
Regeln:
- Beträge als Zahl in Euro mit Punkt als Dezimaltrenner.
- positionen enthält nur Artikelzeilen mit ihrem Endpreis (Menge mal Einzelpreis schon verrechnet). Keine Summenzeile, keine MwSt, keine Zahlungsart.
- Rabatte, Gutscheine und Pfandrückgaben als eigene Position mit negativem Preis.
- gesamt ist der Gesamtbetrag, den man bezahlt hat.
- Ist das Datum nicht lesbar, setze datum auf einen leeren Text.
- Ist etwas nicht lesbar, lasse es weg und rate nicht.`;

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST erforderlich" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return reply(500, { error: "ANTHROPIC_API_KEY fehlt" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Ungültige Anfrage" }); }
  const img = body.image;
  if (!img || typeof img !== "string" || img.length > 7000000) return reply(400, { error: "Bild fehlt oder ist zu groß" });
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType) ? body.mediaType : "image/jpeg";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.BELEG_MODEL || "claude-haiku-5-5",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: img } },
            { type: "text", text: PROMPT }
          ]
        }]
      })
    });
    const j = await r.json();
    if (!r.ok) return reply(502, { error: "Claude Fehler", detail: (j && j.error && j.error.message) || r.status });
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return reply(502, { error: "Keine Antwort lesbar" });
    const d = JSON.parse(m[0]);
    const positionen = (Array.isArray(d.positionen) ? d.positionen : [])
      .map((p) => ({ name: String((p && p.name) || "").slice(0, 80), preis: Number(p && p.preis) }))
      .filter((p) => p.name && isFinite(p.preis));
    return reply(200, {
      haendler: String(d.haendler || "").slice(0, 60),
      datum: /^\d{4}-\d{2}-\d{2}$/.test(d.datum || "") ? d.datum : "",
      gesamt: isFinite(Number(d.gesamt)) ? Number(d.gesamt) : 0,
      positionen
    });
  } catch (e) {
    return reply(500, { error: "Beleg konnte nicht gelesen werden" });
  }
};
