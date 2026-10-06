import express from 'express';
import Stripe from 'stripe';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || '';
const STRIPE_PRICE_BIENNIAL = process.env.STRIPE_PRICE_BIENNIAL || '';
const STRIPE_AUTOMATIC_TAX = /^true$/i.test(process.env.STRIPE_AUTOMATIC_TAX || 'false');
const BA_LICENSE_SERVER_URL = String(process.env.BA_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const BA_COMMERCE_TOKEN = process.env.BA_COMMERCE_TOKEN || '';
const BRAND_SUPPORT_EMAIL = process.env.BRAND_SUPPORT_EMAIL || 'support@fjgate.it';

for (const [name, value] of Object.entries({
  PUBLIC_BASE_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ANNUAL,
  STRIPE_PRICE_BIENNIAL,
  BA_LICENSE_SERVER_URL,
  BA_COMMERCE_TOKEN,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (!PUBLIC_BASE_URL.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use https://');
if (!BA_LICENSE_SERVER_URL.startsWith('https://')) throw new Error('BA_LICENSE_SERVER_URL must use https://');
if (BA_COMMERCE_TOKEN.length < 32) throw new Error('BA_COMMERCE_TOKEN must be at least 32 characters');

const stripe = new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
const app = express();
app.set('trust proxy', 1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com"
  ].join('; '));
  next();
}
app.use(securityHeaders);

// Stripe requires the exact raw request body for signature verification.
app.post('/webhook/stripe', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature rejected:', err?.message || err);
    return res.status(400).send('Invalid signature');
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        await fulfillPaidSession(session);
      }
    }
    return res.json({ received: true });
  } catch (err) {
    // Returning 500 makes Stripe retry the webhook. The license server is idempotent by orderId.
    console.error('Stripe webhook processing failed:', err?.stack || err);
    return res.status(500).json({ received: false });
  }
});

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// Small in-memory anti-abuse limiter. Railway restart simply resets counters.
const buckets = new Map();
function rateLimit(req, res, next) {
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const old = buckets.get(key);
  if (!old || old.resetAt <= now) {
    buckets.set(key, { hits: 1, resetAt: now + 10 * 60_000 });
    return next();
  }
  old.hits += 1;
  if (old.hits > 30) return res.status(429).json({ message: 'Troppi tentativi. Riprova tra qualche minuto.' });
  next();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl/server-side diagnostics
  try { return new URL(origin).origin === new URL(PUBLIC_BASE_URL).origin; }
  catch { return false; }
}
function validUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || '').trim());
}
function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}
function normalizePlan(v) {
  return v === '1y' || v === '2y' ? v : null;
}

async function licenseApi(pathname, body) {
  const r = await fetch(`${BA_LICENSE_SERVER_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${BA_COMMERCE_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(data?.message || `License server HTTP ${r.status}`);
    e.status = r.status;
    e.details = data;
    throw e;
  }
  return data;
}

async function fulfillPaidSession(session) {
  const licenseId = String(session.metadata?.licenseId || '');
  const plan = normalizePlan(session.metadata?.plan);
  if (!validUuid(licenseId) || !plan) throw new Error('Checkout metadata missing or invalid');

  // Stable and unique. Repeated Stripe webhook deliveries are safe.
  const orderId = `stripe:${session.id}`;
  return await licenseApi('/commerce/fulfill', {
    licenseId,
    plan,
    orderId,
    // Intentionally no partnerId: the license server keeps the partner attribution
    // already stored on the trial/license, preventing browser-side tampering.
  });
}

app.get('/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const r = await fetch(`${BA_LICENSE_SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const backend = r.ok ? await r.json() : null;
    res.status(r.ok ? 200 : 503).json({ ok: r.ok, service: 'backup-autopilot-checkout', version: '1.0.0', licenseServer: backend?.ok === true });
  } catch {
    res.status(503).json({ ok: false, service: 'backup-autopilot-checkout', version: '1.0.0', licenseServer: false });
  }
});

app.post('/api/create-checkout-session', rateLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req)) return res.status(403).json({ message: 'Origine richiesta non valida.' });

  const licenseId = String(req.body?.licenseId || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const plan = normalizePlan(req.body?.plan);
  if (!validUuid(licenseId) || !validEmail(email) || !plan) {
    return res.status(400).json({ message: 'Dati di acquisto non validi.' });
  }

  try {
    // Server-to-server validation prevents taking payment for a nonexistent/revoked license
    // or for an email that does not match the existing Backup Autopilot trial.
    await licenseApi('/commerce/validate', { licenseId, email });

    const price = plan === '2y' ? STRIPE_PRICE_BIENNIAL : STRIPE_PRICE_ANNUAL;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price, quantity: 1 }],
      customer_email: email,
      client_reference_id: licenseId,
      metadata: { licenseId, plan, email },
      payment_intent_data: { metadata: { licenseId, plan } },
      success_url: `${PUBLIC_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/cancel.html`,
      automatic_tax: { enabled: STRIPE_AUTOMATIC_TAX },
      allow_promotion_codes: false,
      billing_address_collection: STRIPE_AUTOMATIC_TAX ? 'auto' : 'auto',
      locale: 'it',
    }, {
      idempotencyKey: `checkout:${licenseId}:${plan}:${crypto.randomUUID()}`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Create checkout failed:', err?.stack || err);
    const status = Number(err?.status) || 500;
    if (status >= 400 && status < 500) return res.status(status).json({ message: err.message });
    return res.status(500).json({ message: 'Non è stato possibile avviare il pagamento. Riprova.' });
  }
});

app.get('/api/checkout-status', rateLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query.session_id || '');
  if (!/^cs_(test_)?[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ message: 'Sessione non valida.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    return res.json({
      paymentStatus: session.payment_status,
      status: session.status,
      customerEmail: session.customer_details?.email || session.customer_email || null,
    });
  } catch {
    return res.status(404).json({ message: 'Sessione non trovata.' });
  }
});

app.use(express.static(publicDir, { extensions: ['html'], maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use((req, res) => res.status(404).sendFile(path.join(publicDir, '404.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`F.J.Gate Backup Autopilot checkout listening on :${PORT}`);
  console.log(`Stripe automatic tax: ${STRIPE_AUTOMATIC_TAX ? 'enabled' : 'disabled'}`);
  console.log(`Support email: ${BRAND_SUPPORT_EMAIL}`);
});
