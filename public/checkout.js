const qs = new URLSearchParams(location.search);
const licenseInput = document.getElementById('licenseId');
const emailInput = document.getElementById('email');
const errorBox = document.getElementById('error');
const buttons = [...document.querySelectorAll('[data-plan]')];

licenseInput.value = qs.get('license_id') || qs.get('licenseId') || '';
emailInput.value = qs.get('email') || '';
const preferredPlan = qs.get('plan');
if (preferredPlan === '1y' || preferredPlan === '2y') {
  const el = document.querySelector(`[data-plan="${preferredPlan}"]`);
  if (el) el.scrollIntoView({ block: 'center' });
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = 'block';
  errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function busy(on) {
  buttons.forEach(b => { b.disabled = on; b.textContent = on ? 'Apertura pagamento…' : (b.dataset.plan === '2y' ? 'Acquista 2 anni' : 'Acquista 1 anno'); });
}

buttons.forEach(button => button.addEventListener('click', async () => {
  errorBox.style.display = 'none';
  const licenseId = licenseInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const plan = button.dataset.plan;
  if (!licenseId || !email) return showError('Inserisci ID licenza e email utilizzata nella prova gratuita.');
  busy(true);
  try {
    const r = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseId, email, plan })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) throw new Error(data.message || 'Impossibile avviare il pagamento.');
    location.assign(data.url);
  } catch (e) {
    showError(e.message || 'Errore durante l’apertura del pagamento.');
    busy(false);
  }
}));
