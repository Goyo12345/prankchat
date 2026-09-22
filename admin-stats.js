async function collectStats(stripe, price) {
  const customers = new Set()
  const counts = { active: 0, trialing: 0, past_due: 0, unpaid: 0, ending: 0 }
  for await (const sub of stripe.subscriptions.list({ status: 'all', price, limit: 100 })) {
    if (Object.hasOwn(counts, sub.status)) counts[sub.status]++
    if (sub.status === 'active') {
      customers.add(typeof sub.customer === 'string' ? sub.customer : sub.customer.id)
      if (sub.cancel_at_period_end || sub.cancel_at) counts.ending++
    }
  }
  return { ...counts, customers: customers.size }
}

function page(s) {
  const cards = [
    [s.customers, 'Clients avec abonnement actif'],
    [s.active, 'Abonnements actifs'],
    [s.trialing, 'En période d’essai'],
    [s.past_due + s.unpaid, 'Paiements en retard / impayés'],
    [s.ending, 'Actifs avec résiliation programmée']
  ]
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PrankChat — Abonnements</title><style>body{margin:0;background:#101321;color:#f5f6ff;font:17px system-ui;padding:clamp(20px,5vw,72px)}main{max-width:1050px;margin:auto}h1{font-size:clamp(28px,5vw,44px)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}article{padding:28px;background:#1e2337;border:1px solid #363d56;border-radius:18px}strong{display:block;font-size:42px;color:#ff7997}p{color:#bec5da;line-height:1.6}a{display:inline-block;color:#fff;background:#ad294d;padding:12px 20px;border-radius:10px;text-decoration:none}</style><main><p>PRANKCHAT · STATISTIQUES</p><h1>Vos abonnements</h1><p>Données Stripe consultées le ${new Date().toLocaleString('fr-CH', {timeZone:'Europe/Zurich'})} (heure suisse).</p><div class="grid">${cards.map(([n,label]) => `<article><strong>${n}</strong>${label}</article>`).join('')}</div><p>Clients distincts pour le tarif PrankChat configuré. Les essais et les impayés sont séparés. Un abonnement « actif » est un statut Stripe : ce chiffre ne représente pas les encaissements nets et peut inclure un tarif remisé. Les résiliations programmées restent actives jusqu’à leur échéance.</p><a href="/stats">Actualiser les chiffres</a></main></html>`
}

function handleStats(req, res, stripe, price) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.method !== 'GET') { res.writeHead(405); res.end('Méthode non autorisée.'); return }
  if (!stripe) { res.writeHead(503); res.end('Stripe non configuré.'); return }
  return collectStats(stripe, price).then(s => { res.writeHead(200); res.end(page(s)) }).catch(() => {
    res.writeHead(502); res.end('Impossible de consulter Stripe. Réessayez dans quelques instants.')
  })
}
module.exports = { collectStats, page, handleStats }

