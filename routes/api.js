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
const { COLONNES_DOCUMENT, COLONNES_DOCUMENT_D } = require('../database/colonnes')
const { Resend } = require('resend')
const supabase = require('../database/supabase')
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib')
const resend = new Resend(process.env.RESEND_API_KEY)
const { envoyerEmailBienvenue } = require('../services/email')
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { verifierTurnstile } = require('../services/turnstile')
const { jetonValide } = require('../utils/desabonnement')


// Petit helper pour uniformiser les erreurs JSON
function fail(res, status, message) {
  return res.status(status).json({ error: message })
}



// Transforme la saisie en requête de recherche : chaque mot est cherché par son début,
// sans accent ni majuscule (« maths » trouve « mathématiques »). Seules les lettres et
// les chiffres sont gardés, ce qui empêche toute injection dans la requête.
function construireRecherche(q) {
  const mots = String(q).normalize('NFC').split(/\s+/)
    .map(m => m.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 8)
  return mots.length ? mots.map(m => m + ':*').join(' & ') : null
}

function construireFiltreRecherche(q, i, params) {
  const terme = String(q).trim().slice(0, 100)
  const conditions = []
  let ordre = 'd.date_upload DESC'
  const requete = construireRecherche(terme)
  if (requete) {
    conditions.push(`d.recherche_vecteur @@ to_tsquery('french_unaccent', $${i})`)
    ordre = `ts_rank(d.recherche_vecteur, to_tsquery('french_unaccent', $${i})) DESC, d.date_upload DESC`
    params.push(requete)
    i++
  }
  if (terme.length >= 3) {
    conditions.push(`d.titre ILIKE $${i}`)
    params.push('%' + terme + '%')
    i++
  }
  return { clause: conditions.length ? ` AND (${conditions.join(' OR ')})` : ' AND FALSE', ordre, i }
}


const echapperHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// Limite les tentatives de connexion/inscription — protège contre le
// brute-force et la création de comptes en masse par script.
const limiterAuth = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8,
  message: { error: 'Trop de tentatives. Réessaie dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const limiterReset = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes. Réessaie dans une heure.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Limite les téléchargements et lectures — un utilisateur normal ne
// consulte pas 40 documents en quelques minutes, un script qui aspire le
// catalogue oui.


const limiterTelechargement = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 30,
  skipFailedRequests: true, // un téléchargement qui échoue ne consomme pas le quota
  message: { error: 'Limite de téléchargements atteinte. Réessaie dans une heure.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session.user ? String(req.session.user.id) : ipKeyGenerator(req.ip)),
})

// La consultation en ligne a son propre quota, plus large : ouvrir une fiche
// ne doit pas épuiser les téléchargements.
const limiterLecture = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  skipFailedRequests: true,
  message: { error: 'Trop de documents consultés. Réessaie dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session.user ? String(req.session.user.id) : ipKeyGenerator(req.ip)),
})

// Limite la consultation de la liste/fiche des documents — ralentit le
// scraping automatisé du catalogue.
const limiterDocuments = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 120,
  message: { error: 'Trop de requêtes. Réessaie dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})



// Extrait le chemin du fichier dans le bucket, que fichierUrl soit une URL
// complète (documents uploadés via l'admin) ou déjà un chemin brut
// (documents importés en masse via le script CSV).
function extraireCheminFichier(fichierUrl) {
  if (!fichierUrl.startsWith('http')) return fichierUrl
  const marker = '/documents/'
  const idx = fichierUrl.indexOf(marker)
  if (idx === -1) throw new Error('URL de fichier invalide.')
  return fichierUrl.substring(idx + marker.length)
}

// Génère une URL signée temporaire à partir de l'URL publique stockée en base.
// Remplace l'ancien renvoi direct de l'URL publique (faille corrigée).
async function getSignedUrl(fichierUrl, { download = false, expiresIn = 300 } = {}) {
  const filename = extraireCheminFichier(fichierUrl)
  const options = download ? { download: true } : {}
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(filename, expiresIn, options)

  if (error) throw new Error('Impossible de générer le lien : ' + error.message)
  return data.signedUrl
}

// Ajoute un filigrane diagonal et semi-transparent ("EduBF · edubf.net") sur
// chaque page d'un PDF, pour dissuader la redistribution des documents
// téléchargés.
async function filigranerPdf(pdfBytes) {
  const pdfDoc = await PDFDocument.load(pdfBytes)
  const police = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const texte = 'EduBF · edubf.net'
  const taille = 42

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize()
    const largeurTexte = police.widthOfTextAtSize(texte, taille)

    // Répète le filigrane à plusieurs endroits de la page (pas juste au
    // centre), pour qu'il reste visible même si une partie du document est
    // recadrée ou capturée en photo.
    const positions = [
      { x: width / 2 - largeurTexte / 2, y: height * 0.75 },
      { x: width / 2 - largeurTexte / 2, y: height / 2 },
      { x: width / 2 - largeurTexte / 2, y: height * 0.25 },
    ]

    for (const pos of positions) {
      page.drawText(texte, {
        x: pos.x,
        y: pos.y,
        size: taille,
        font: police,
        color: rgb(0.5, 0.5, 0.5),
        opacity: 0.32,
        rotate: degrees(45),
      })
    }
  }

  return pdfDoc.save()
}


// Middleware : utilisateur connecté requis
function requireAuth(req, res, next) {
  if (!req.session.user) return fail(res, 401, 'Non authentifié.')
  next()
}

// ===================== AUTH =====================

router.post('/auth/register', limiterAuth, async (req, res, next) => {
  try {
    const { nom_complet, email, mot_de_passe, niveau_scolaire, classe, filiere, turnstileToken } = req.body

    if (!nom_complet || !email || !mot_de_passe) {
      return fail(res, 400, 'Tous les champs obligatoires doivent être remplis.')
    }

    const humainVerifie = await verifierTurnstile(turnstileToken, req.ip)
    if (!humainVerifie) {
      return fail(res, 400, 'Vérification de sécurité échouée. Recharge la page et réessaie.')
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

router.post('/auth/login', limiterAuth, async (req, res, next) => {
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

       const utilisateur = {
      id: user.id,
      nom_complet: user.nom_complet,
      email: user.email,
      classe: user.classe,
      filiere: user.filiere,
    }

    req.session.regenerate((err) => {
      if (err) return next(err)
      req.session.user = utilisateur
      req.session.save((err2) => {
        if (err2) return next(err2)
        res.json({ user: utilisateur })
      })
    })
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
           user: (({ mot_de_passe, ...reste }) => reste)(userRows[0]),
      commentaires,
      stats: {
        total_commentaires: commentaires.length,
        total_notes: commentaires.filter(c => c.note).length,
        total_favoris: parseInt(favRows[0].n),
      },
    })
  } catch (err) { next(err) }
})

router.post('/auth/forgot-password', limiterReset, async (req, res, next) => {
  try {
    const { email } = req.body
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase().trim()])
    const user = rows[0]
    const message = 'Si cet email existe, un lien de réinitialisation a été envoyé.'

    if (!user) return res.json({ message })
    const token = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const expiration = new Date(Date.now() + 1000 * 60 * 60)
    await db.query('UPDATE reset_tokens SET utilise = TRUE WHERE user_id = $1 AND utilise = FALSE', [user.id])
    await db.query(
      'INSERT INTO reset_tokens (user_id, token, expire_le) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiration]
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
          <p style="color:#475569;">Bonjour ${echapperHtml(user.nom_complet)},</p>
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
           [crypto.createHash('sha256').update(req.params.token).digest('hex')]
    )
    res.json({ valid: !!rows[0] })
  } catch (err) { next(err) }
})

router.post('/auth/reset-password/:token', limiterReset, async (req, res, next) => {
  try {
    const { mot_de_passe, confirmation } = req.body
      const token = crypto.createHash('sha256').update(req.params.token).digest('hex')

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

router.get('/documents/home', limiterDocuments, async (req, res, next) => {
  try {
    const { rows: documents } = await db.query(
      `SELECT ${COLONNES_DOCUMENT} FROM documents WHERE actif = 1 ORDER BY date_upload DESC LIMIT 6`
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

router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.nom, c.slug, c.icone, c.ordre, COUNT(d.id) AS nb_documents
      FROM categories c
      LEFT JOIN documents d ON d.categorie_id = c.id AND d.actif = 1
      GROUP BY c.id, c.nom, c.slug, c.icone, c.ordre
      ORDER BY c.ordre
    `)
    res.json({ categories: rows })
  } catch (err) { next(err) }
})

router.get('/types-document', async (req, res, next) => {
  try {
    const { categorie_id } = req.query
    const { rows } = categorie_id
      ? await db.query('SELECT id, nom FROM types_document WHERE categorie_id = $1 ORDER BY nom', [categorie_id])
      : await db.query('SELECT id, nom, categorie_id FROM types_document ORDER BY nom')
    res.json({ types_document: rows })
  } catch (err) { next(err) }
})

router.get('/examens', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, nom, type_formation FROM examens ORDER BY ordre, nom')
    res.json({ examens: rows })
  } catch (err) { next(err) }
})

router.get('/matieres', async (req, res, next) => {
  try {
        const { rows } = await db.query('SELECT MIN(id) AS id, nom FROM matieres GROUP BY nom ORDER BY nom')
    res.json({ matieres: rows })
  } catch (err) { next(err) }
})

router.get('/series', async (req, res, next) => {
  try {
    const { examen_id } = req.query
    if (!examen_id) return res.json({ series: [] })
    const { rows } = await db.query(
      'SELECT id, nom, type, groupe FROM series_filieres WHERE examen_id = $1 ORDER BY groupe, ordre, nom',
      [examen_id]
    )
    res.json({ series: rows })
  } catch (err) { next(err) }
})


router.get('/documents', limiterDocuments, async (req, res, next) => {
  try {
    const { q, categorie_id, examen_id, serie_id, matiere_id, type_precis_id, page = 1 } = req.query
    const limit = 12
    const offset = (parseInt(page) - 1) * limit

    let whereClause = 'WHERE d.actif = 1'
    const params = []
    let i = 1

       let ordre = 'd.date_upload DESC'
    if (q) {
      const filtre = construireFiltreRecherche(q, i, params)
      whereClause += filtre.clause
      ordre = filtre.ordre
      i = filtre.i
    }
    if (categorie_id) { whereClause += ` AND d.categorie_id = $${i}`; params.push(categorie_id); i++ }
    if (examen_id) { whereClause += ` AND d.examen_id = $${i}`; params.push(examen_id); i++ }
    if (type_precis_id) { whereClause += ` AND d.type_precis_id = $${i}`; params.push(type_precis_id); i++ }
    if (serie_id) {
      whereClause += ` AND EXISTS (SELECT 1 FROM document_series ds WHERE ds.document_id = d.id AND ds.serie_id = $${i})`
      params.push(serie_id); i++
    }
        if (matiere_id) {
      whereClause += ` AND EXISTS (
        SELECT 1 FROM document_matieres dm
        JOIN matieres m ON m.id = dm.matiere_id
        WHERE dm.document_id = d.id
          AND m.nom = (SELECT nom FROM matieres WHERE id = $${i})
      )`
      params.push(matiere_id); i++
    }

    const { rows: countRows } = await db.query(`SELECT COUNT(*) as n FROM documents d ${whereClause}`, params)
    const total = parseInt(countRows[0].n)
    const totalPages = Math.ceil(total / limit)

    const { rows: documents } = await db.query(
      `SELECT ${COLONNES_DOCUMENT_D}, c.nom AS categorie_nom, e.nom AS examen_nom, td.nom AS type_precis_nom
       FROM documents d
       LEFT JOIN categories c ON c.id = d.categorie_id
       LEFT JOIN examens e ON e.id = d.examen_id
       LEFT JOIN types_document td ON td.id = d.type_precis_id
       ${whereClause}
      ORDER BY ${ordre} LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    )

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120')
    res.json({
      documents,
      filtres: { q, categorie_id, examen_id, serie_id, matiere_id, type_precis_id },
      pagination: { page: parseInt(page), totalPages, total },
    })
  } catch (err) { next(err) }
})




// ==========================================================================
// CONCOURS — routes publiques (utilisateur connecte)
// ==========================================================================

router.get('/concours/domaines', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nom, icone FROM concours.domaines WHERE actif = true ORDER BY nom'
    )
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600')
    res.json({ domaines: rows })
  } catch (err) { next(err) }
})

router.get('/concours/domaines/:id/series', async (req, res, next) => {
  try {
    const userId = req.session.user?.id || null
    const { rows } = await db.query(`
      SELECT s.id, s.titre, s.description, s.difficulte, s.nb_questions_cible,
        prog.meilleur_score, prog.nb_tentatives
      FROM concours.series s
      LEFT JOIN LATERAL (
        SELECT MAX(sess.score) AS meilleur_score, COUNT(*)::int AS nb_tentatives
        FROM concours.sessions sess
        WHERE sess.serie_id = s.id AND sess.user_id = $2 AND sess.statut = 'terminee'
      ) prog ON $2::int IS NOT NULL
      WHERE s.domaine_id = $1 AND s.statut = 'publiee'
      ORDER BY s.date_publication DESC
    `, [req.params.id, userId])
    res.set('Cache-Control', 'private, max-age=0, must-revalidate')
    res.json({ series: rows })
  } catch (err) { next(err) }
})

// Demarre une session : soit depuis une serie precise, soit en entrainement
// personnalise (domaine_ids + nb_questions). Cree le SNAPSHOT immediatement —
// a partir d'ici, la session ne relit plus jamais concours.questions.
router.post('/concours/sessions', requireAuth, async (req, res, next) => {
  try {
    const { serie_id, domaine_ids, nb_questions, difficulte } = req.body
    let questions

    if (serie_id) {
      const { rows: serieRows } = await db.query(
        `SELECT * FROM concours.series WHERE id = $1 AND statut = 'publiee'`, [serie_id]
      )
      if (!serieRows[0]) return fail(res, 404, 'Série introuvable ou non publiée.')
            const { rows } = await db.query(`
        SELECT q.id, q.type, q.enonce, q.difficulte, q.explication, q.reponse_texte,
          (SELECT json_agg(json_build_object('id', p.id, 'texte', p.texte, 'correcte', p.est_correcte) ORDER BY p.ordre)
           FROM concours.propositions p WHERE p.question_id = q.id) AS propositions
        FROM concours.serie_questions sq
        JOIN concours.questions q ON q.id = sq.question_id AND q.statut = 'publiee'
        WHERE sq.serie_id = $1
        ORDER BY sq.ordre
      `, [serie_id])
      questions = rows
    } else {
          if (!Array.isArray(domaine_ids) || domaine_ids.length === 0 || domaine_ids.length > 20) {
        return fail(res, 400, 'Choisis entre 1 et 20 domaines.')
      }
      const n = Math.min(Math.max(parseInt(nb_questions) || 20, 1), 100)
      const params = [domaine_ids, n]
      let filtreDifficulte = ''
      if (difficulte) { filtreDifficulte = 'AND q.difficulte = $3'; params.push(difficulte) }

            const { rows } = await db.query(`
        SELECT q.id, q.type, q.enonce, q.difficulte, q.explication, q.reponse_texte,
          (SELECT json_agg(json_build_object('id', p.id, 'texte', p.texte, 'correcte', p.est_correcte) ORDER BY p.ordre)
           FROM concours.propositions p WHERE p.question_id = q.id) AS propositions
        FROM concours.questions q
        WHERE q.domaine_id = ANY($1) AND q.statut = 'publiee' ${filtreDifficulte}
        ORDER BY RANDOM() LIMIT $2
      `, params)
      questions = rows
    }

    if (questions.length === 0) return fail(res, 400, 'Aucune question disponible pour ces critères.')

    const { rows: sessionRows } = await db.query(
      `INSERT INTO concours.sessions (user_id, serie_id, domaines_choisis, nb_questions, statut)
       VALUES ($1,$2,$3,$4,'en_cours') RETURNING id`,
      [req.session.user.id, serie_id || null, serie_id ? null : JSON.stringify(domaine_ids), questions.length]
    )
    const sessionId = sessionRows[0].id

    for (const [i, q] of questions.entries()) {
      await db.query(
        `INSERT INTO concours.session_questions (session_id, question_id, ordre, contenu_snapshot)
         VALUES ($1,$2,$3,$4)`,
        [sessionId, q.id, i, JSON.stringify({
          enonce: q.enonce, type: q.type, difficulte: q.difficulte,
                   explication: q.explication, propositions: q.propositions || null,
          reponse_texte: q.reponse_texte || null,
        })]
      )
    }

    res.status(201).json({ session_id: sessionId, nb_questions: questions.length })
  } catch (err) { next(err) }
})


router.get('/concours/mes-sessions', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT sess.id, sess.nb_questions, sess.score, sess.statut,
        sess.date_debut, sess.date_fin, s.titre AS serie_titre, s.id AS serie_id,
        sess.domaines_choisis
      FROM concours.sessions sess
      LEFT JOIN concours.series s ON s.id = sess.serie_id
      WHERE sess.user_id = $1
      ORDER BY sess.date_debut DESC
      LIMIT 50
    `, [req.session.user.id])
    res.set('Cache-Control', 'private, max-age=0, must-revalidate')
    res.json({ sessions: rows })
  } catch (err) { next(err) }
})

router.use('/concours/sessions/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return fail(res, 404, 'Session introuvable.')
  next()
})

// Contenu de la session pour PASSER le quiz — les bonnes reponses sont
// retirees ici, elles n'apparaissent qu'au resultat final.
router.get('/concours/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: sessionRows } = await db.query(
      'SELECT * FROM concours.sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.user.id]
    )
    if (!sessionRows[0]) return fail(res, 404, 'Session introuvable.')

    const { rows: sq } = await db.query(
      'SELECT id, question_id, ordre, contenu_snapshot FROM concours.session_questions WHERE session_id = $1 ORDER BY ordre',
      [req.params.id]
    )
    const { rows: reponsesDeja } = await db.query(
      'SELECT session_question_id FROM concours.reponses_session WHERE session_id = $1',
      [req.params.id]
    )
    const idsReponduees = new Set(reponsesDeja.map(r => r.session_question_id))

    const questions = sq.map(q => ({
      session_question_id: q.id,
      ordre: q.ordre,
      enonce: q.contenu_snapshot.enonce,
      type: q.contenu_snapshot.type,
      difficulte: q.contenu_snapshot.difficulte,
      propositions: q.contenu_snapshot.propositions
        ? q.contenu_snapshot.propositions.map(p => ({ id: p.id, texte: p.texte }))
        : null,
      deja_repondue: idsReponduees.has(q.id),
    }))

    res.json({ session: sessionRows[0], questions })
  } catch (err) { next(err) }
})

router.post('/concours/sessions/:id/reponses', requireAuth, async (req, res, next) => {
  try {
    const { session_question_id, proposition_choisie_id, reponse_texte_donnee } = req.body
        if (reponse_texte_donnee && String(reponse_texte_donnee).length > 500) {
      return fail(res, 400, 'Réponse trop longue.')
    }
    const { rows: sessionRows } = await db.query(
      `SELECT * FROM concours.sessions WHERE id = $1 AND user_id = $2 AND statut = 'en_cours'`,
      [req.params.id, req.session.user.id]
    )
    if (!sessionRows[0]) return fail(res, 404, 'Session introuvable ou déjà terminée.')

    const { rows: sqRows } = await db.query(
      'SELECT * FROM concours.session_questions WHERE id = $1 AND session_id = $2',
      [session_question_id, req.params.id]
    )
    if (!sqRows[0]) return fail(res, 404, 'Question introuvable dans cette session.')

    const snapshot = sqRows[0].contenu_snapshot
    let correcte
    if (snapshot.propositions) {
      const bonne = snapshot.propositions.find(p => p.correcte)
      correcte = bonne && String(bonne.id) === String(proposition_choisie_id)
    } else {
            const attendue = (snapshot.reponse_texte || '').trim().toLowerCase()
      const donnee = (reponse_texte_donnee || '').trim().toLowerCase()
      correcte = attendue !== '' && donnee === attendue
    }

       const { rows: inseree } = await db.query(
      `INSERT INTO concours.reponses_session (session_id, session_question_id, proposition_choisie_id, reponse_texte_donnee, correcte)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (session_id, session_question_id) DO NOTHING
       RETURNING id`,
      [req.params.id, session_question_id, proposition_choisie_id || null, reponse_texte_donnee || null, !!correcte]
    )
    if (!inseree[0]) return fail(res, 409, 'Tu as déjà répondu à cette question.')

    res.status(201).json({ success: true })
  } catch (err) { next(err) }
})

router.put('/concours/sessions/:id/terminer', requireAuth, async (req, res, next) => {
  try {
    const { rows: sessions } = await db.query(
      `SELECT id FROM concours.sessions WHERE id = $1 AND user_id = $2 AND statut = 'en_cours'`,
      [req.params.id, req.session.user.id]
    )
    if (!sessions[0]) return fail(res, 404, 'Session introuvable ou déjà terminée.')

    const { rows: reponses } = await db.query(
      'SELECT COUNT(*) FILTER (WHERE correcte) as bonnes FROM concours.reponses_session WHERE session_id = $1',
      [req.params.id]
    )
    const score = parseInt(reponses[0].bonnes)

    await db.query(
      `UPDATE concours.sessions SET statut = 'terminee', score = $1, date_fin = NOW()
       WHERE id = $2 AND user_id = $3`,
      [score, req.params.id, req.session.user.id]
    )

    res.json({ score })
  } catch (err) { next(err) }
})






router.get('/concours/sessions/:id/resultat', requireAuth, async (req, res, next) => {
  try {
    const { rows: sessionRows } = await db.query(
      `SELECT * FROM concours.sessions WHERE id = $1 AND user_id = $2 AND statut = 'terminee'`,
      [req.params.id, req.session.user.id]
    )
    if (!sessionRows[0]) return fail(res, 404, 'Résultat non disponible (session introuvable ou non terminée).')
    const session = sessionRows[0]

    const { rows: sq } = await db.query(
      `SELECT sq.id, sq.ordre, sq.contenu_snapshot, rs.proposition_choisie_id, rs.reponse_texte_donnee, rs.correcte
       FROM concours.session_questions sq
       LEFT JOIN concours.reponses_session rs ON rs.session_question_id = sq.id
       WHERE sq.session_id = $1 ORDER BY sq.ordre`,
      [req.params.id]
    )

    const questions = sq.map(q => ({
      ordre: q.ordre,
      enonce: q.contenu_snapshot.enonce,
      explication: q.contenu_snapshot.explication,
      propositions: q.contenu_snapshot.propositions || null,
      reponse_correcte_texte: q.contenu_snapshot.propositions ? null : q.contenu_snapshot.reponse_texte,
      proposition_choisie_id: q.proposition_choisie_id,
      reponse_texte_donnee: q.reponse_texte_donnee,
      correcte: q.correcte,
    }))

    res.json({
      score: session.score,
      total: session.nb_questions,
      pourcentage: Math.round((session.score / session.nb_questions) * 100),
      questions,
    })
  } catch (err) { next(err) }
})



router.get('/documents/:id', limiterDocuments, async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT ${COLONNES_DOCUMENT} FROM documents WHERE id = $1 AND actif = 1`, [req.params.id])
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
router.get('/documents/:id/telecharger', requireAuth, limiterTelechargement, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND actif = 1', [req.params.id])
    const document = rows[0]
    if (!document) return fail(res, 404, 'Document introuvable.')

    // Récupère le fichier original depuis Supabase, ajoute le filigrane, puis
    // renvoie directement le PDF modifié — le téléchargement ne dépend plus
    // d'une URL exposée au navigateur.
    const filename = extraireCheminFichier(document.fichier_url)
    const { data, error } = await supabase.storage.from('documents').download(filename)
    if (error) throw new Error('Impossible de récupérer le fichier : ' + error.message)

    const pdfBytesOriginal = Buffer.from(await data.arrayBuffer())

    let pdfBytesFiligrane
    try {
      pdfBytesFiligrane = await filigranerPdf(pdfBytesOriginal)
    } catch (err) {
      if (/encrypted/i.test(err.message)) {
        console.error(`PDF protégé : filigrane impossible pour le document ${document.id}`)
        return fail(res, 422, "Ce document ne peut pas être téléchargé pour le moment. Tu peux le consulter en ligne.")
      }
      throw err
    }

    // Le compteur n'augmente qu'une fois le fichier prêt à être envoyé
    await db.query('UPDATE documents SET nb_telechargements = nb_telechargements + 1 WHERE id = $1', [document.id])
    reco.enregistrerAction(req.session.user.id, document.id, 'telechargement').catch(() => {})

    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename="${document.titre.replace(/[^a-z0-9]/gi, '_')}.pdf"`)
    res.send(Buffer.from(pdfBytesFiligrane))
  } catch (err) { next(err) }
})

router.get('/documents/:id/lire', requireAuth, limiterLecture, async (req, res, next) => {  try {
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
      SELECT ${COLONNES_DOCUMENT_D} FROM favoris f
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

function pageSimple(message) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EduBF</title></head><body style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 16px;text-align:center"><h2>EduBF</h2><p>${message}</p></body></html>`
}

router.get('/desabonnement', async (req, res, next) => {
  try {
    const email = String(req.query.email || '').toLowerCase().trim()
    const token = String(req.query.token || '')
    if (!email || !jetonValide(email, token)) {
      return res.status(400).type('html').send(pageSimple('Lien invalide ou expiré.'))
    }
    await db.query(
      'INSERT INTO email_desabonnes (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email]
    )
    res.type('html').send(pageSimple('Tu es désabonné. Tu ne recevras plus nos annonces.'))
  } catch (err) { next(err) }
})



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
