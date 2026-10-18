// POST /api/pay
// { network, phone, email, amount }            -> starts a mobile money charge
// { action: "otp", otp, reference }            -> submits an OTP/voucher if Paystack asks for one
const PS = 'https://api.paystack.co';
const PROVIDERS = { mtn: 'mtn', telecel: 'vod', airteltigo: 'atl' };
const MIN_GHS = Number(process.env.MIN_PRICE_GHS || 1);
const MAX_GHS = 1000;

const headers = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json'
});
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const out = j =>
  j.status && j.data
    ? reply(200, {
        status: j.data.status,
        reference: j.data.reference,
        message: j.data.display_text || j.message
      })
    : reply(400, { status: 'failed', message: j.message || 'Payment could not be started.' });

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  if (!process.env.PAYSTACK_SECRET_KEY) return reply(500, { message: 'Server not configured.' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }

  try {
    if (b.action === 'otp') {
      if (!/^\d{3,8}$/.test(String(b.otp || '')) || !b.reference)
        return reply(400, { message: 'Invalid code.' });
      const r = await fetch(`${PS}/charge/submit_otp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ otp: String(b.otp), reference: b.reference })
      });
      return out(await r.json());
    }

    const provider = PROVIDERS[b.network];
    const amount = Number(b.amount);
    let phone = String(b.phone || '').replace(/[\s+]/g, '');
    if (phone.startsWith('233')) phone = '0' + phone.slice(3);

    if (!provider) return reply(400, { message: 'Unknown network.' });
    if (!/^0\d{9}$/.test(phone)) return reply(400, { message: 'Invalid phone number.' });
    if (!/^\S+@\S+\.\S+$/.test(b.email || '')) return reply(400, { message: 'A valid email is required.' });
    if (!(amount >= MIN_GHS && amount <= MAX_GHS))
      return reply(400, { message: `Amount must be between GHS ${MIN_GHS} and ${MAX_GHS}.` });

    const reference = 'sp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const r = await fetch(`${PS}/charge`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        email: b.email,
        amount: Math.round(amount * 100), // pesewas
        currency: 'GHS',
        reference,
        mobile_money: { phone, provider }
      })
    });
    return out(await r.json());
  } catch (e) {
    return reply(502, { message: 'Could not reach the payment provider.' });
  }
};
