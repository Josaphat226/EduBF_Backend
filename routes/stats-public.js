// ==========================================================================
// Suivi d'audience des visiteurs. Monté dans server.js :
//   app.use('/api/stats', require('./routes/stats-public'))
// Les administrateurs connectés et les robots ne sont jamais comptés.
// ==========================================================================
const express = require('express')
const rateLimit = require('express-rate-limit')
const router = express.Router()
const db = require('../database/database')
const stats = require('../services/stats')

const limiteur = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false })
router.use(limiteur)

const ID = /^[A-Za-z0-9_-]{8,40}$/

// Ignore silencieusement (204) : un suivi qui échoue ne doit jamais se voir.
function ignorer(req) {
  return (req.session && req.session.admin) || stats.estBot(req.get('user-agent'))
}

// Une page vue. Réponse : { id } à renvoyer ensuite avec chaque « battement ».
router.post('/vue', async (req, res) => {
  try {
    if (ignorer(req)) return res.status(204).end()
    const { visiteur, session, chemin, referrer, utm, premiere } = req.body || {}
    if (!ID.test(String(visiteur)) || !ID.test(String(session))) return res.status(204).end()
    const chem = String(chemin || '').split('?')[0].split('#')[0].slice(0, 300)
    if (!chem.startsWith('/') || chem.startsWith('/admin') || chem.startsWith('/api')) return res.status(204).end()

    const hoteSite = String(req.get('host') || '').split(':')[0].replace(/^www\./, '')
    const src = premiere ? stats.source(String(referrer || ''), utm, hoteSite) : 'interne'
    const userId = req.session && req.session.user ? req.session.user.id : null

    const { rows } = await db.query(
      `INSERT INTO visites (visiteur_id, session_id, user_id, chemin, source, appareil)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [visiteur, session, userId, chem, src, stats.appareil(req.get('user-agent'))]
    )
    res.json({ id: rows[0].id })
  } catch (err) {
    console.error('Erreur stats /vue:', err.message)
    res.status(204).end()
  }
})

// Signe de vie : ajoute le temps réellement passé sur la page (page visible à l'écran).
router.post('/battement', async (req, res) => {
  try {
    if (ignorer(req)) return res.status(204).end()
    const { id, visiteur, secondes } = req.body || {}
    const n = Math.min(60, Math.max(1, parseInt(secondes, 10) || 0))
    if (!/^\d+$/.test(String(id)) || !ID.test(String(visiteur))) return res.status(204).end()
    await db.query(
      `UPDATE visites SET secondes = LEAST(secondes + $3, 7200), vu_a = now()
        WHERE id = $1 AND visiteur_id = $2 AND created_at > now() - interval '4 hours'`,
      [id, visiteur, n]
    )
    res.status(204).end()
  } catch (err) {
    console.error('Erreur stats /battement:', err.message)
    res.status(204).end()
  }
})

module.exports = router