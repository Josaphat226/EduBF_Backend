// ==========================================================================
// API JSON — consommée par le frontend React (Vite).
// Reprend exactement la même logique métier / les mêmes requêtes SQL que
// les anciennes routes EJS de server.js, mais répond en JSON au lieu de
// faire un res.render / res.redirect.
//
// Monté dans server.js via : app.use('/api', require('./routes/api'))
// ==========================================================================



const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const db = require('../database/database')
const reco = require('../database/recommandation')
const { Resend } = require('resend')
const supabase = require('../database/supabase')
const resend = new Resend(process.env.RESEND_API_KEY)
const { envoyerEmailBienvenue } = require('../services/email')

// Petit helper pour uniformiser les erreurs JSON
function fail(res, status, message) {
  return res.status(status).json({ error: message })
}



// Génère une URL signée temporaire à partir de l'URL publique stockée en base.
// Remplace l'ancien renvoi direct de l'URL publique (faille corrigée).
async function getSignedUrl(fichierUrl, { download = false, expiresIn = 300 } = {}) {
  let filename = fichierUrl

  // Si c'est une URL complète (documents uploadés via l'admin), on en extrait
  // juste le chemin du fichier. Si c'est déjà un chemin brut (documents
  // importés en masse via le script CSV), on l'utilise tel quel.
  if (fichierUrl.startsWith('http')) {
    const marker = '/documents/'
    const idx = fichierUrl.indexOf(marker)
    if (idx === -1) throw new Error('URL de fichier invalide.')
    filename = fichierUrl.substring(idx + marker.length)
  }

  const options = download ? { download: true } : {}
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(filename, expiresIn, options)

  if (error) throw new Error('Impossible de générer le lien : ' + error.message)
  return data.signedUrl
}


// Middleware : utilisateur connecté requis
function requireAuth(req, res, next) {
  if (!req.session.user) return fail(res, 401, 'Non authentifié.')
  next()
}

// ===================== AUTH =====================

router.post('/auth/register', async (req, res, next) => {
  try {
    const { nom_complet, email, mot_de_passe, niveau_scolaire, classe, filiere } = req.body

    if (!nom_complet || !email || !mot_de_passe) {
      return fail(res, 400, 'Tous les champs obligatoires doivent être remplis.')
    }
    if (mot_de_passe.length < 8) {
      return fail(res, 400, 'Le mot de passe doit faire au moins 8 caractères.')
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(res, 400, 'Adresse email invalide.')
    }

    const { rows: existant } = await db.query(
      'SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]
    )
    if (existant.length > 0) {
      return fail(res, 409, 'Cet email est déjà utilisé.')
    }

    const hash = await bcrypt.hash(mot_de_passe, 12)
    const { rows } = await db.query(
      `INSERT INTO users
        (nom_complet, email, mot_de_passe, filiere_preferee, filiere, classe, email_verifie)
        VALUES ($1, $2, $3, $4, $4, $5, 1) RETURNING *`,
      [nom_complet.trim(), email.toLowerCase().trim(), hash, filiere || null, classe || null]
    )

  req.session.user = {
      id: rows[0].id,
      nom_complet: rows[0].nom_complet,
      email: rows[0].email,
      classe: rows[0].classe,
      filiere: rows[0].filiere,
    }

    // Pas de "await" volontairement : on ne fait pas attendre l'utilisateur
    // pour l'envoi de l'email, l'inscription répond tout de suite.
    envoyerEmailBienvenue(rows[0].email, rows[0].nom_complet)

    res.status(201).json({ user: req.session.user })
  } catch (err) { next(err) }
})

router.post('/auth/login', async (req, res, next) => {
  try {
    const { email, mot_de_passe } = req.body
    if (!email || !mot_de_passe) return fail(res, 400, 'Email et mot de passe requis.')

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()])
    const user = rows[0]

    if (!user || !(await bcrypt.compare(mot_de_passe, user.mot_de_passe))) {
      return fail(res, 401, 'Email ou mot de passe incorrect.')
    }
    if (user.statut === 'suspendu') {
      return fail(res, 403, 'Votre compte a été suspendu.')
    }

    req.session.user = {
      id: user.id,
      nom_complet: user.nom_complet,
      email: user.email,
      classe: user.classe,
      filiere: user.filiere,
    }

    res.json({ user: req.session.user })
  } catch (err) { next(err) }
})

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }))
})

router.get('/auth/me', (req, res) => {
  res.json({ user: req.session.user || null })
})

router.put('/auth/profile', requireAuth, async (req, res, next) => {
  try {
    const { nom_complet, classe, filiere, nouveau_mot_de_passe } = req.body

    if (!nom_complet || nom_complet.trim().length < 2) {
      return fail(res, 400, 'Le nom complet est obligatoire.')
    }

    await db.query(
      'UPDATE users SET nom_complet = $1, classe = $2, filiere = $3, filiere_preferee = $3 WHERE id = $4',
      [nom_complet.trim(), classe || null, filiere || null, req.session.user.id]
    )

    if (nouveau_mot_de_passe && nouveau_mot_de_passe.length >= 8) {
      const hash = await bcrypt.hash(nouveau_mot_de_passe, 12)
      await db.query('UPDATE users SET mot_de_passe = $1 WHERE id = $2', [hash, req.session.user.id])
    }

    req.session.user = {
      ...req.session.user,
      nom_complet: nom_complet.trim(),
      classe: classe || null,
      filiere: filiere || null,
    }
    req.session.save(() => res.json({ user: req.session.user }))
  } catch (err) { next(err) }
})

router.get('/auth/profile/full', requireAuth, async (req, res, next) => {
  try {
    const { rows: userRows } = await db.query('SELECT * FROM users WHERE id = $1', [req.session.user.id])
    const { rows: commentaires } = await db.query(`
      SELECT c.*, d.titre as titre_document FROM commentaires c
      JOIN documents d ON c.document_id = d.id
      WHERE c.user_id = $1 ORDER BY c.date_publication DESC
    `, [req.session.user.id])
    const { rows: favRows } = await db.query(
      'SELECT COUNT(*) as n FROM favoris WHERE user_id = $1', [req.session.user.id]
    )

    res.json({
      user: userRows[0],
      commentaires,
      stats: {
        total_commentaires: commentaires.length,
        total_notes: commentaires.filter(c => c.note).length,
        total_favoris: parseInt(favRows[0].n),
      },
    })
  } catch (err) { next(err) }
})

router.post('/auth/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase().trim()])
    const user = rows[0]
    const message = 'Si cet email existe, un lien de réinitialisation a été envoyé.'

    if (!user) return res.json({ message })

    const token = crypto.randomBytes(32).toString('hex')
    const expiration = new Date(Date.now() + 1000 * 60 * 60)
    await db.query(
      'INSERT INTO reset_tokens (user_id, token, expire_le) VALUES ($1, $2, $3)',
      [user.id, token, expiration]
    )

    const lien = `${process.env.FRONTEND_URLS.split(',')[0]}/reinitialiser-mot-de-passe/${token}`
   await resend.emails.send({
      from: 'EduBF <noreply@edubf.net>',
      to: user.email,
      subject: 'Réinitialisation de ton mot de passe — EduBF',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem;">
          <div style="text-align:center;margin-bottom:1.5rem;">
            <span style="font-size:1.5rem;font-weight:900;color:#F59E0B;">EDUBF</span>
          </div>
          <h2 style="color:#0F172A;margin-bottom:0.5rem;">Réinitialisation de mot de passe</h2>
          <p style="color:#475569;">Bonjour ${user.nom_complet},</p>
          <p style="color:#475569;">Tu as demandé à réinitialiser ton mot de passe. Clique sur le bouton ci-dessous :</p>
          <div style="text-align:center;margin:2rem 0;">
            <a href="${lien}" style="background:#F59E0B;color:white;padding:0.8rem 2rem;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">
              Réinitialiser mon mot de passe
            </a>
          </div>
          <p style="color:#94A3B8;font-size:0.85rem;">Ce lien expire dans 1 heure. Si tu n'as pas fait cette demande, ignore cet email.</p>
        </div>
      `,
    })

    res.json({ message })
  } catch (err) { next(err) }
})

router.get('/auth/reset-password/:token', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM reset_tokens WHERE token = $1 AND utilise = FALSE AND expire_le > NOW()',
      [req.params.token]
    )
    res.json({ valid: !!rows[0] })
  } catch (err) { next(err) }
})

router.post('/auth/reset-password/:token', async (req, res, next) => {
  try {
    const { mot_de_passe, confirmation } = req.body
    const token = req.params.token

    if (mot_de_passe !== confirmation) return fail(res, 400, 'Les mots de passe ne correspondent pas.')
    if (!mot_de_passe || mot_de_passe.length < 8) return fail(res, 400, 'Le mot de passe doit faire au moins 8 caractères.')

    const { rows } = await db.query(
      'SELECT * FROM reset_tokens WHERE token = $1 AND utilise = FALSE AND expire_le > NOW()',
      [token]
    )
    if (!rows[0]) return fail(res, 400, 'Ce lien est invalide ou a expiré.')

    const hash = await bcrypt.hash(mot_de_passe, 12)
    await db.query('UPDATE users SET mot_de_passe = $1 WHERE id = $2', [hash, rows[0].user_id])
    await db.query('UPDATE reset_tokens SET utilise = TRUE WHERE token = $1', [token])

    res.json({ message: 'Mot de passe modifié avec succès ! Tu peux maintenant te connecter.' })
  } catch (err) { next(err) }
})

// ===================== DOCUMENTS (public) =====================

router.get('/documents/home', async (req, res, next) => {
  try {
    const { rows: documents } = await db.query(
      'SELECT * FROM documents WHERE actif = 1 ORDER BY date_upload DESC LIMIT 6'
    )
    const { rows } = await db.query('SELECT COUNT(*) as n FROM documents WHERE actif = 1')
    const totalDocs = parseInt(rows[0].n)

    let recommandations = []
    try {
      if (req.session.user) {
        recommandations = await reco.getRecommandations(req.session.user.id, { limite: 6 })
      } else {
        recommandations = await reco.getRecommandationsVisiteur(6)
      }
    } catch (e) {
      recommandations = documents
    }

    res.json({ documents, recommandations, totalDocs })
  } catch (err) { next(err) }
})

router.get('/documents', async (req, res, next) => {
  try {
    const { q, cycle, matiere, type_document, page = 1 } = req.query
    const limit = 12
    const offset = (parseInt(page) - 1) * limit

    let whereClause = 'WHERE d.actif = 1'
    const params = []
    let i = 1

    if (q) {
      whereClause += ` AND (d.titre ILIKE $${i} OR d.description ILIKE $${i + 1})`
      params.push('%' + q + '%', '%' + q + '%')
      i += 2
    }
    if (cycle) { whereClause += ` AND d.cycle = $${i}`; params.push(cycle); i++ }
    if (matiere) { whereClause += ` AND d.matiere = $${i}`; params.push(matiere); i++ }
    if (type_document) { whereClause += ` AND d.type_document = $${i}`; params.push(type_document); i++ }

    const { rows: countRows } = await db.query(`SELECT COUNT(*) as n FROM documents d ${whereClause}`, params)
    const total = parseInt(countRows[0].n)
    const totalPages = Math.ceil(total / limit)

    const { rows: documents } = await db.query(
      `SELECT d.* FROM documents d ${whereClause} ORDER BY d.date_upload DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    )

    // Liste publique, identique pour tous les visiteurs : cache navigateur/CDN
    // 30s + revalidation en arriere-plan jusqu'a 2min (stale-while-revalidate)
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120')
    res.json({
      documents,
      filtres: { q, cycle, matiere, type_document },
      pagination: { page: parseInt(page), totalPages, total },
    })
  } catch (err) { next(err) }
})

router.get('/documents/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND actif = 1', [req.params.id])
    const document = rows[0]
    if (!document) return fail(res, 404, 'Document introuvable.')

    if (req.session.user) {
      reco.enregistrerAction(req.session.user.id, document.id, 'vue').catch(() => {})
    }

    const { rows: commentaires } = await db.query(`
      SELECT c.*, u.nom_complet FROM commentaires c
      JOIN users u ON c.user_id = u.id
      WHERE c.document_id = $1 AND c.visible = 1
      ORDER BY c.date_publication DESC
    `, [document.id])

    let estFavori = false
    if (req.session.user) {
      const { rows: fav } = await db.query(
        'SELECT id FROM favoris WHERE user_id = $1 AND document_id = $2',
        [req.session.user.id, document.id]
      )
      estFavori = fav.length > 0
    }

    const similaires = await reco.getDocumentsSimilaires(document.id, 4)

    // Contenu propre a chaque utilisateur (estFavori) : cache navigateur
    // uniquement (private), jamais un cache partage/CDN
    res.set('Cache-Control', 'private, max-age=30')
    res.json({ document, commentaires, estFavori, similaires })
  } catch (err) { next(err) }
})

router.get('/documents/:id/telecharger', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND actif = 1', [req.params.id])
    const document = rows[0]
    if (!document) return fail(res, 404, 'Document introuvable.')

    await db.query('UPDATE documents SET nb_telechargements = nb_telechargements + 1 WHERE id = $1', [document.id])
    reco.enregistrerAction(req.session.user.id, document.id, 'telechargement').catch(() => {})

    const url = await getSignedUrl(document.fichier_url, { download: true })
    res.json({ url })
  } catch (err) { next(err) }
})

router.get('/documents/:id/lire', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND actif = 1', [req.params.id])
    const document = rows[0]
    if (!document) return fail(res, 404, 'Document introuvable.')

    reco.enregistrerAction(req.session.user.id, document.id, 'lecture').catch(() => {})

    const url = await getSignedUrl(document.fichier_url)
    res.json({ url })
  } catch (err) { next(err) }
})

router.post('/documents/:id/commentaires', requireAuth, async (req, res, next) => {
  try {
    const { contenu, note } = req.body
    const document_id = req.params.id

    if (!contenu || contenu.trim().length < 5 || contenu.length > 500) {
      return fail(res, 400, 'Le commentaire doit faire entre 5 et 500 caractères.')
    }

    await db.query(
      'INSERT INTO commentaires (document_id, user_id, contenu, note, visible) VALUES ($1, $2, $3, $4, 0)',
      [document_id, req.session.user.id, contenu.trim(), note || null]
    )
    reco.enregistrerAction(req.session.user.id, document_id, 'commentaire').catch(() => {})

    res.status(201).json({ success: true, message: 'Commentaire envoyé, il sera visible après validation.' })
  } catch (err) { next(err) }
})

router.post('/documents/:id/favori', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM favoris WHERE user_id = $1 AND document_id = $2',
      [req.session.user.id, req.params.id]
    )

    if (rows.length > 0) {
      await db.query('DELETE FROM favoris WHERE user_id = $1 AND document_id = $2', [req.session.user.id, req.params.id])
      res.json({ success: true, action: 'removed' })
    } else {
      await db.query('INSERT INTO favoris (user_id, document_id) VALUES ($1, $2)', [req.session.user.id, req.params.id])
      reco.enregistrerAction(req.session.user.id, req.params.id, 'favori').catch(() => {})
      res.json({ success: true, action: 'added' })
    }
  } catch (err) { next(err) }
})

router.get('/favoris', requireAuth, async (req, res, next) => {
  try {
    const { rows: favoris } = await db.query(`
      SELECT d.* FROM favoris f
      JOIN documents d ON f.document_id = d.id
      WHERE f.user_id = $1 AND d.actif = 1
      ORDER BY f.date_ajout DESC
    `, [req.session.user.id])
    res.json({ favoris })
  } catch (err) { next(err) }
})

// ===================== CONTACT =====================

router.post('/contact', async (req, res, next) => {
  try {
    const { nom, email, sujet, message } = req.body
    if (!nom || !email || !message) return fail(res, 400, 'Tous les champs obligatoires doivent être remplis.')

   await resend.emails.send({
      from: 'EduBF <noreply@edubf.net>',
      to: 'contact@edubf.net',
      reply_to: email,
      subject: `[Contact EduBF] ${sujet || 'Nouveau message'}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem;">
          <h2 style="color:#0F172A;">Nouveau message de contact</h2>
          <p><strong>Nom :</strong> ${nom}</p>
          <p><strong>Email :</strong> ${email}</p>
          <p><strong>Sujet :</strong> ${sujet || '—'}</p>
          <p><strong>Message :</strong></p>
          <p style="white-space:pre-wrap;">${message}</p>
        </div>
      `,
    })

    res.json({ success: true, message: 'Ton message a bien été envoyé, merci !' })
  } catch (err) { next(err) }
})


// ===================== NEWSLETTER =====================

router.post('/newsletter/abonner', async (req, res, next) => {
  try {
    const { email } = req.body
    const emailValide = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')
    if (!emailValide) return fail(res, 400, 'Adresse email invalide.')

    // ON CONFLICT DO NOTHING : si l'email est déjà abonné, on ne renvoie
    // pas d'erreur — on répond simplement comme si ça avait marché, pour
    // ne pas révéler à quelqu'un si une adresse est déjà dans la liste.
    await db.query(
      'INSERT INTO newsletter_abonnes (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email]
    )

    res.json({ success: true, message: 'Merci, tu es bien abonné(e) !' })
  } catch (err) { next(err) }
})

// ===================== TRACKER =====================

router.post('/tracker', async (req, res) => {
  try {
    if (!req.session.user) return res.json({ ok: false })
    const { document_id, duree } = req.body
    if (!document_id || !duree) return res.json({ ok: false })
    await reco.enregistrerAction(req.session.user.id, document_id, 'lecture', parseInt(duree))
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false })
  }
})

module.exports = router
