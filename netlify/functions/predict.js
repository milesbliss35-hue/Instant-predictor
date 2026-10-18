// POST /api/predict  { image?: "data:image/jpeg;base64,...", matches?: ["A vs B"], reference }
// Reads the screenshot, finds the matches, and estimates a score for each.
// Set REQUIRE_PAYMENT=false in Netlify env vars to allow free testing.
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const SYSTEM = `You read screenshots of football (soccer) betting slips and fixture lists, then estimate scores.
Find every football match shown in the image (maximum 10) and also include any matches typed by the user.
Reply with ONLY a JSON array, no other text, one object per match:
[{"match":"<Home vs Away>","home":<int 0-6>,"away":<int 0-6>,"note":"<one short sentence>"}]
If you cannot find any matches, reply with [].
You only know general team strength from training data. You have no live form, injuries, lineups or odds, so keep notes modest and never claim certainty.`;

async function isPaid(reference) {
  if (!reference || !/^[\w-]{6,64}$/.test(reference)) return false;
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
  });
  const j = await r.json();
  const min = Number(process.env.MIN_PRICE_GHS || 1) * 100;
  return !!(j.status && j.data && j.data.status === 'success' && j.data.currency === 'GHS' && j.data.amount >= min);
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return reply(500, { message: 'Server not configured.' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }

  const typed = (Array.isArray(b.matches) ? b.matches : [])
    .map(m => String(m).trim().slice(0, 100)).filter(Boolean).slice(0, 10);
  const imgOk = typeof b.image === 'string' && /^data:image\/jpeg;base64,/.test(b.image) && b.image.length < 5000000;
  if (!imgOk && !typed.length) return reply(400, { message: 'Upload a screenshot first.' });

  try {
    if (process.env.REQUIRE_PAYMENT !== 'false') {
      if (!process.env.PAYSTACK_SECRET_KEY) return reply(500, { message: 'Server not configured.' });
      if (!(await isPaid(b.reference))) return reply(402, { message: 'Payment required.' });
    }

    const userText = typed.length
      ? 'Also include these typed matches:\n' + typed.map((m, i) => `${i + 1}. ${m}`).join('\n')
      : 'Read the matches in the screenshot and estimate each score.';
    const b64 = imgOk ? b.image.split(',')[1] : null;
    let text = '';

    if (process.env.GEMINI_API_KEY) {
      // Free option: Google Gemini (key from aistudio.google.com/apikey)
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const parts = [{ text: userText }];
      if (b64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1200 }
        })
      });
      const j = await r.json();
      text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(x => x.text || '').join('');
    } else {
      const content = [];
      if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      content.push({ type: 'text', text: userText });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
          max_tokens: 1200,
          system: SYSTEM,
          messages: [{ role: 'user', content }]
        })
      });
      const j = await r.json();
      text = (j.content || []).map(c => c.text || '').join('');
    }
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    const arr = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : [];

    const predictions = arr.slice(0, 10).map(p => ({
      match: String(p.match || '').slice(0, 100),
      home: Math.max(0, Math.min(9, parseInt(p.home, 10) || 0)),
      away: Math.max(0, Math.min(9, parseInt(p.away, 10) || 0)),
      note: String(p.note || '').slice(0, 200)
    })).filter(p => p.match);
    return reply(200, { predictions });
  } catch (e) {
    return reply(502, { message: 'Prediction failed. Try again.' });
  }
};
