// Outils des statistiques d'audience (voir migration 031).
const db = require('../database/database')

const BOTS = /bot|crawl|spider|slurp|headless|lighthouse|monitor|preview|facebookexternalhit|whatsapp\/|curl|wget|python-requests|node-fetch/i

function estBot(userAgent) {
  return !userAgent || BOTS.test(userAgent)
}

function appareil(userAgent) {
  const ua = String(userAgent || '')
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablette'
  if (/mobi|iphone|android/i.test(ua)) return 'mobile'
  return 'ordinateur'
}

// D'où vient le visiteur : « utm_source » prioritaire, sinon le site de provenance.
function source(referrer, utm, hoteSite) {
  const u = String(utm || '').toLowerCase().trim()
  if (u) {
    if (/whatsapp|wa$/.test(u)) return 'whatsapp'
    if (/facebook|fb/.test(u)) return 'facebook'
    if (/google/.test(u)) return 'google'
    if (/tiktok/.test(u)) return 'tiktok'
    if (/instagram|ig$/.test(u)) return 'instagram'
    if (/youtube/.test(u)) return 'youtube'
    if (/telegram/.test(u)) return 'telegram'
    return u.replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'autre'
  }
  let hote = ''
  try { hote = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '') } catch { return 'direct' }
  if (!hote) return 'direct'
  if (hoteSite && (hote === hoteSite || hote.endsWith('.' + hoteSite))) return 'interne'
  if (/(^|\.)google\./.test(hote)) return 'google'
  if (/(^|\.)(bing|duckduckgo|yahoo|ecosia|qwant)\./.test(hote)) return 'moteur'
  if (/facebook\.com$|fb\.com$|^l\.facebook|^m\.facebook/.test(hote)) return 'facebook'
  if (/whatsapp\.com$|wa\.me$/.test(hote)) return 'whatsapp'
  if (/instagram\.com$/.test(hote)) return 'instagram'
  if (/tiktok\.com$/.test(hote)) return 'tiktok'
  if (/youtube\.com$|youtu\.be$/.test(hote)) return 'youtube'
  if (/t\.co$|twitter\.com$|x\.com$/.test(hote)) return 'x'
  if (/telegram\.org$|t\.me$/.test(hote)) return 'telegram'
  return 'autre'
}

// Enregistre une recherche (jamais bloquant). Une même recherche répétée en quelques secondes
// (le serveur Next.js lit parfois la page deux fois) n'est comptée qu'une fois.
const recentes = new Map()
function enregistrerRecherche(terme, nbResultats, origine) {
  try {
    const t = String(terme || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100)
    if (t.length < 2) return
    const cle = `${origine}|${t}`
    const maintenant = Date.now()
    if (recentes.has(cle) && maintenant - recentes.get(cle) < 15000) return
    recentes.set(cle, maintenant)
    if (recentes.size > 500) for (const [k, v] of recentes) if (maintenant - v > 15000) recentes.delete(k)
    db.query('INSERT INTO recherches (terme, origine, nb_resultats) VALUES ($1, $2, $3)', [t, origine, Math.max(0, parseInt(nbResultats, 10) || 0)])
      .catch((err) => console.error('Erreur enregistrerRecherche:', err.message))
  } catch { /* les statistiques ne doivent jamais gêner le site */ }
}

module.exports = { estBot, appareil, source, enregistrerRecherche }