// ==========================================================================
// PDF des exercices corrigés — réception des PDF fabriqués par l'outil "outils-pdf"
// ==========================================================================
const crypto = require('crypto')
const express = require('express')
const multer = require('multer')
const router = express.Router()
const db = require('../database/database')
const supabase = require('../database/supabase')

const BUCKET_PDF = 'contenus-pdf'
const FORMAT_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/

const recevoir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 } })
  .fields([{ name: 'sujet', maxCount: 1 }, { name: 'corrige', maxCount: 1 }])

function secretValide(req) {
  const attendu = Buffer.from(process.env.PDF_SECRET || '')
  const recu = Buffer.from(String(req.get('x-pdf-secret') || ''))
  return attendu.length >= 20 && attendu.length === recu.length && crypto.timingSafeEqual(attendu, recu)
}

router.use((req, res, next) => {
  if (!secretValide(req)) return res.status(401).json({ error: 'Non autorisé.' })
  next()
})

router.param('code', (req, res, next, code) => {
  const c = String(code).trim().toUpperCase()
  if (!FORMAT_CODE.test(c)) return res.status(404).json({ error: 'Contenu introuvable.' })
  req.params.code = c
  next()
})
router.param('numero', (req, res, next, n) => {
  if (!/^\d{1,6}$/.test(n)) return res.status(404).json({ error: 'Version introuvable.' })
  next()
})

let bucketPret = false
async function assurerBucket() {
  if (bucketPret) return
  const { error } = await supabase.storage.createBucket(BUCKET_PDF, { public: true })
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw new Error('Bucket PDF : ' + error.message)
  bucketPret = true
}

router.get('/a-generer', async (req, res, next) => {
  try {
    const tout = req.query.tout === '1'
    const { rows } = await db.query(
      `SELECT c.code, v.numero
         FROM pedagogie.contenus c
         JOIN pedagogie.versions v ON v.id = c.version_publiee_id
        WHERE c.actif AND ($1::boolean OR (v.pdf_statut <> 'pret' AND v.pdf_tentatives < 5))
        ORDER BY v.date_publication LIMIT 100`,
      [tout]
    )
    res.json({ a_generer: rows.map((r) => ({ code: r.code, numero: r.numero })) })
  } catch (err) { next(err) }
})

router.post('/:code/:numero', (req, res, next) => {
  recevoir(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Envoi invalide : ' + err.message })
    try {
      const sujet = req.files && req.files.sujet && req.files.sujet[0]
      const corrige = req.files && req.files.corrige && req.files.corrige[0]
      if (!sujet || !corrige) return res.status(400).json({ error: 'Il faut envoyer les deux fichiers (sujet et corrige).' })
      for (const f of [sujet, corrige]) {
        if (f.buffer.length < 1000 || f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'Un des fichiers n\'est pas un PDF valide.' })
      }

      const { rows } = await db.query(
        `SELECT v.id FROM pedagogie.versions v JOIN pedagogie.contenus c ON c.id = v.contenu_id
          WHERE c.code = $1 AND v.numero = $2 AND v.statut = 'publiee'`,
        [req.params.code, req.params.numero]
      )
      if (!rows[0]) return res.status(404).json({ error: 'Version publiée introuvable.' })

      await assurerBucket()
      const base = `${req.params.code}-v${req.params.numero}-${Date.now()}`
      const urls = {}
      for (const [nom, fichier] of [['sujet', sujet], ['corrige', corrige]]) {
        const chemin = `${base}-${nom}.pdf`
        const { error } = await supabase.storage.from(BUCKET_PDF).upload(chemin, fichier.buffer, { contentType: 'application/pdf', upsert: false })
        if (error) throw new Error('Envoi vers le stockage : ' + error.message)
        urls[nom] = supabase.storage.from(BUCKET_PDF).getPublicUrl(chemin).data.publicUrl
      }

      await db.query(
        `UPDATE pedagogie.versions
            SET pdf_sujet_url = $2, pdf_corrige_url = $3, pdf_statut = 'pret', pdf_erreur = NULL, pdf_genere_le = now()
          WHERE id = $1`,
        [rows[0].id, urls.sujet, urls.corrige]
      )
      res.json({ ok: true })
    } catch (e) { next(e) }
  })
})

router.post('/:code/:numero/echec', express.json({ limit: '10kb' }), async (req, res, next) => {
  try {
    const message = String((req.body && req.body.erreur) || 'Erreur inconnue').slice(0, 500)
    await db.query(
      `UPDATE pedagogie.versions v
          SET pdf_statut = 'echec', pdf_erreur = $3, pdf_tentatives = v.pdf_tentatives + 1
         FROM pedagogie.contenus c
        WHERE c.id = v.contenu_id AND c.code = $1 AND v.numero = $2 AND v.statut = 'publiee'`,
      [req.params.code, req.params.numero, message]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router