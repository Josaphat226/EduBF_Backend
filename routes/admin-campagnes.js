const express = require('express')
const router = express.Router()
const db = require('../database/database')
const {
  LIMITE_JOUR, construireEmail, compterDestinataires,
  envoyesAujourdhui, envoyerTest, traiterCampagnes
} = require('../services/campagnes')

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}

router.use((req, res, next) => {
  if (!req.session.admin) return fail(res, 401, 'Non authentifié (admin).')
  next()
})

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return fail(res, 404, 'Campagne introuvable.')
  next()
})

const CIBLES = ['utilisateurs', 'newsletter', 'tous']

function valider(body) {
  const titre = String(body.titre || '').trim()
  const sujet = String(body.sujet || '').trim()
  const message = String(body.message || '').trim()
  const bouton_texte = String(body.bouton_texte || '').trim() || null
  const bouton_lien = String(body.bouton_lien || '').trim() || null
  const cible = body.cible

  if (!titre || titre.length > 150) return { erreur: 'Titre obligatoire (150 caractères maximum).' }
  if (!sujet || sujet.length > 200) return { erreur: 'Sujet obligatoire (200 caractères maximum).' }
  if (!message || message.length > 5000) return { erreur: 'Message obligatoire (5000 caractères maximum).' }
  if (!CIBLES.includes(cible)) return { erreur: 'Destinataires invalides.' }
  if (bouton_texte && bouton_texte.length > 60) return { erreur: 'Texte du bouton trop long (60 caractères maximum).' }
  if (bouton_texte && !bouton_lien) return { erreur: 'Ajoute le lien du bouton.' }
  if (bouton_lien && (bouton_lien.length > 500 || !/^https?:\/\//i.test(bouton_lien))) {
    return { erreur: 'Le lien du bouton doit commencer par http:// ou https://.' }
  }
  return { valeurs: { titre, sujet, message, bouton_texte, bouton_lien, cible } }
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campagnes_email ORDER BY id DESC LIMIT 100')
    res.json({ campagnes: rows, quota: { limite: LIMITE_JOUR, utilises: await envoyesAujourdhui() } })
  } catch (err) { next(err) }
})

router.get('/destinataires', async (req, res, next) => {
  try {
    if (!CIBLES.includes(req.query.cible)) return fail(res, 400, 'Destinataires invalides.')
    res.json({ total: await compterDestinataires(req.query.cible) })
  } catch (err) { next(err) }
})

router.post('/', async (req, res, next) => {
  try {
    const { erreur, valeurs: v } = valider(req.body)
    if (erreur) return fail(res, 400, erreur)
    const { rows } = await db.query(
      `INSERT INTO campagnes_email (titre, sujet, message, bouton_texte, bouton_lien, cible, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [v.titre, v.sujet, v.message, v.bouton_texte, v.bouton_lien, v.cible, req.session.admin?.id ?? null])
    res.status(201).json({ id: rows[0].id })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campagnes_email WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Campagne introuvable.')
    res.json({ campagne: rows[0] })
  } catch (err) { next(err) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { erreur, valeurs: v } = valider(req.body)
    if (erreur) return fail(res, 400, erreur)
    const { rowCount } = await db.query(
      `UPDATE campagnes_email SET titre=$2, sujet=$3, message=$4, bouton_texte=$5, bouton_lien=$6, cible=$7
       WHERE id = $1 AND statut = 'brouillon'`,
      [req.params.id, v.titre, v.sujet, v.message, v.bouton_texte, v.bouton_lien, v.cible])
    if (!rowCount) return fail(res, 409, 'Seul un brouillon peut être modifié.')
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM campagnes_email WHERE id = $1 AND statut = 'brouillon'`, [req.params.id])
    if (!rowCount) return fail(res, 409, 'Seul un brouillon peut être supprimé.')
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.get('/:id/apercu', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campagnes_email WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Campagne introuvable.')
    res.json({ html: construireEmail(rows[0], 'exemple@exemple.com').html })
  } catch (err) { next(err) }
})

router.post('/:id/test', async (req, res, next) => {
  try {
    const adresse = String(req.body.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adresse)) return fail(res, 400, 'Adresse e-mail invalide.')
    const { rows } = await db.query('SELECT * FROM campagnes_email WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Campagne introuvable.')
    await envoyerTest(rows[0], adresse)
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.post('/:id/lancer', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM campagnes_email WHERE id = $1', [req.params.id])
    const c = rows[0]
    if (!c) return fail(res, 404, 'Campagne introuvable.')
    if (c.statut !== 'brouillon') return fail(res, 409, 'Cette campagne a déjà été lancée.')

    const total = await compterDestinataires(c.cible, c.id)
    if (total === 0) return fail(res, 400, 'Aucun destinataire pour cette campagne.')

    const { rowCount } = await db.query(
      `UPDATE campagnes_email SET statut = 'en_cours', total_destinataires = $2,
         date_lancement = NOW(), admin_id = $3
       WHERE id = $1 AND statut = 'brouillon'`,
      [c.id, total, req.session.admin?.id ?? null])
    if (!rowCount) return fail(res, 409, 'Cette campagne a déjà été lancée.')

    traiterCampagnes().catch(() => {})
    res.json({ success: true, total })
  } catch (err) { next(err) }
})

function changerStatut(depuis, vers) {
  return async (req, res, next) => {
    try {
      const { rowCount } = await db.query(
        `UPDATE campagnes_email SET statut = $2 WHERE id = $1 AND statut = ANY($3::text[])`,
        [req.params.id, vers, depuis])
      if (!rowCount) return fail(res, 409, 'Action impossible dans l\'état actuel de la campagne.')
      if (vers === 'en_cours') traiterCampagnes().catch(() => {})
      res.json({ success: true })
    } catch (err) { next(err) }
  }
}

router.post('/:id/pause', changerStatut(['en_cours'], 'en_pause'))
router.post('/:id/reprendre', changerStatut(['en_pause'], 'en_cours'))
router.post('/:id/annuler', changerStatut(['en_cours', 'en_pause'], 'annulee'))

module.exports = router