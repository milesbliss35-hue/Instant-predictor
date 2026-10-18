// GET /api/verify?reference=...  -> { status, amount, currency }
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  const ref = (event.queryStringParameters || {}).reference;
  if (!ref || !/^[\w-]{6,64}$/.test(ref)) return reply(400, { message: 'Bad reference.' });
  if (!process.env.PAYSTACK_SECRET_KEY) return reply(500, { message: 'Server not configured.' });
  try {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const j = await r.json();
    if (!j.status || !j.data) return reply(200, { status: 'pending', message: j.message });
    return reply(200, {
      status: j.data.status,
      amount: j.data.amount,
      currency: j.data.currency,
      message: j.data.gateway_response
    });
  } catch (e) {
    return reply(502, { message: 'Could not reach the payment provider.' });
  }
};
