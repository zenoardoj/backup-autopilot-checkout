const statusEl = document.getElementById('status');
const id = new URLSearchParams(location.search).get('session_id');
let tries = 0;
async function check() {
  if (!id) { statusEl.textContent = 'Pagamento completato. Torna a Backup Autopilot e aggiorna lo stato della licenza.'; return; }
  tries++;
  try {
    const r = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const d = await r.json();
    if (r.ok && d.paymentStatus === 'paid') {
      statusEl.innerHTML = '<span class="ok">Pagamento confermato.</span> L’attivazione viene completata automaticamente dal server.';
      return;
    }
  } catch {}
  if (tries < 10) setTimeout(check, 2000);
  else statusEl.textContent = 'Il pagamento è in verifica. Torna a Backup Autopilot e aggiorna lo stato tra qualche istante.';
}
check();
