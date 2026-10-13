// ==========================================================================
// API JSON ADMIN — consommée par le futur panel React /admin.
// Monté dans server.js via : app.use('/api/admin', require('./routes/admin-api'))
// ==========================================================================

const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const multer = require('multer')
const db = require('../database/database')
const supabase = require('../database/supabase')
const { PDFDocument } = require('pdf-lib')

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}


// Les pages publiques lisent encore type_document, cycle et matiere :
// on les met à jour à partir des liaisons choisies dans l'admin
async function synchroniserChampsDocument(docId) {
  await db.query(
    `UPDATE documents d SET
       type_document = COALESCE(NULLIF(d.type_document, ''), (SELECT td.nom FROM types_document td WHERE td.id = d.type_precis_id)),
       cycle = COALESCE((SELECT e.nom FROM examens e WHERE e.id = d.examen_id), d.cycle),
       matiere = COALESCE((SELECT string_agg(m.nom, ', ' ORDER BY m.nom) FROM document_matieres dm JOIN matieres m ON m.id = dm.matiere_id WHERE dm.document_id = d.id), d.matiere)
     WHERE d.id = $1`,
    [docId]
  )
}

// Auth admin requise (session)
function requireAdmin(req, res, next) {
  if (!req.session.admin) return fail(res, 401, 'Non authentifié (admin).')
  next()
}


async function getSignedUrlAdmin(fichierUrl, expiresIn = 300) {
  let filename = fichierUrl

  if (fichierUrl.startsWith('http')) {
    const marker = '/documents/'
    const idx = fichierUrl.indexOf(marker)
    if (idx === -1) throw new Error('URL de fichier invalide.')
    filename = fichierUrl.substring(idx + marker.length)
  }

  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(filename, expiresIn)

  if (error) throw new Error('Impossible de générer le lien : ' + error.message)
  return data.signedUrl
}



async function genererSeriesAutomatiques(domaineId, domaineNom, tailleSerie) {
  const { rows: dispo } = await db.query(`
    SELECT q.id FROM concours.questions q
    WHERE q.domaine_id = $1 AND q.statut = 'publiee'
      AND NOT EXISTS (SELECT 1 FROM concours.serie_questions sq WHERE sq.question_id = q.id)
    ORDER BY q.date_creation ASC
  `, [domaineId])

  if (dispo.length === 0) return []

  // Un ou plusieurs lots pleins de tailleSerie, PLUS un eventuel dernier lot
  // partiel (le reste) — on ne jette plus jamais de questions de cote.
  const lots = []
  for (let i = 0; i < dispo.length; i += tailleSerie) {
    lots.push(dispo.slice(i, i + tailleSerie))
  }

  const { rows: compteRows } = await db.query(
    'SELECT COUNT(*) as n FROM concours.series WHERE domaine_id = $1', [domaineId]
  )
  let numeroSuivant = parseInt(compteRows[0].n) + 1

  const seriesCreees = []
  for (const lot of lots) {
    const complet = lot.length >= tailleSerie
    const titre = `${domaineNom} — Série ${String(numeroSuivant).padStart(2, '0')}`

    // La serie est TOUJOURS creee avec ses questions deja rattachees.
    // Seul le statut differe : 'publiee' si pleine, 'incomplete' sinon
    // (donc invisible des utilisateurs, mais deja prete a etre completee
    // par un futur import du meme domaine).
    const { rows: serieRows } = await db.query(
      `INSERT INTO concours.series (domaine_id, titre, nb_questions_cible, statut, date_publication)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, titre, statut`,
      [domaineId, titre, tailleSerie, complet ? 'publiee' : 'incomplete', complet ? new Date() : null]
    )
    const serieId = serieRows[0].id
    for (const [idx, q] of lot.entries()) {
      await db.query(
        'INSERT INTO concours.serie_questions (serie_id, question_id, ordre) VALUES ($1,$2,$3)',
        [serieId, q.id, idx]
      )
    }
    seriesCreees.push(serieRows[0])
    numeroSuivant++
  }
  return seriesCreees
}


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true)
    else cb(new Error('Seuls les fichiers PDF sont acceptés.'))
  },
})


const { analyserFichierBrut, validerEtClasser } = require('../services/concoursImport')

const uploadTexte = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo, largement suffisant pour du texte
  fileFilter: (req, file, cb) => {
    const extensionsAcceptees = ['.txt', '.csv', '.json']
    const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase()
    if (extensionsAcceptees.includes(ext)) cb(null, true)
    else cb(new Error('Format non supporté. Utilise .txt, .csv ou .json.'))
  },
})

async function uploadPDF(file) {
    // Vérifie que le fichier est un vrai PDF exploitable avant de le stocker
  if (!file.buffer.subarray(0, 1024).includes('%PDF-')) {
    const e = new Error("Ce fichier n'est pas un PDF valide.")
    e.status = 400
    throw e
  }
  try {
    await PDFDocument.load(file.buffer)
  } catch (err) {
    const e = new Error(
      /encrypted/i.test(err.message)
        ? "Ce PDF est protégé (mot de passe ou restrictions). Retire la protection avant de l'envoyer : ouvre-le dans Chrome, Imprimer, puis Enregistrer au format PDF."
        : "Ce PDF est illisible ou corrompu. Réexporte-le puis réessaie."
    )
    e.status = 400
    throw e
  }
  const filename = Date.now() + '-' + file.originalname.replace(/\s/g, '-').replace(/[^a-zA-Z0-9.\-_]/g, '')
  const { error } = await supabase.storage.from('documents').upload(filename, file.buffer, { contentType: 'application/pdf' })
  if (error) throw new Error('Erreur upload fichier : ' + error.message)
   return filename
}

async function logAction(req, action, cible, cible_id, details) {
  await db.query(
    'INSERT INTO admin_actions (admin_id, action, cible, cible_id, details) VALUES ($1,$2,$3,$4,$5)',
    [req.session.admin.id, action, cible, cible_id, details]
  )
}

// ===================== AUTH ADMIN =====================

router.post('/login', async (req, res, next) => {
  try {
    const { email, mot_de_passe } = req.body
    const { rows } = await db.query('SELECT * FROM admins WHERE email = $1', [email])
    const admin = rows[0]

    if (!admin || !(await bcrypt.compare(mot_de_passe, admin.mot_de_passe))) {
      return fail(res, 401, 'Email ou mot de passe incorrect.')
    }

       const adminSession = { id: admin.id, nom: admin.nom, email: admin.email }
    req.session.regenerate((err) => {
      if (err) return next(err)
      req.session.admin = adminSession
      req.session.save((err2) => {
        if (err2) return next(err2)
        res.json({ admin: adminSession })
      })
    })
  } catch (err) { next(err) }
})

router.post('/logout', (req, res) => {
  req.session.admin = null
  res.json({ success: true })
})

router.get('/me', (req, res) => {
  res.json({ admin: req.session.admin || null })
})

// ===================== DASHBOARD =====================

router.get('/dashboard', requireAdmin, async (req, res, next) => {
  try {
    const { rows: d } = await db.query('SELECT COUNT(*) as n FROM documents')
    const { rows: u } = await db.query('SELECT COUNT(*) as n FROM users')
    const { rows: t } = await db.query('SELECT SUM(nb_telechargements) as n FROM documents')
    const { rows: c } = await db.query('SELECT COUNT(*) as n FROM commentaires WHERE visible = 0')
    const { rows: documents } = await db.query('SELECT * FROM documents ORDER BY date_upload DESC LIMIT 8')
    const { rows: derniers_users } = await db.query('SELECT * FROM users ORDER BY date_inscription DESC LIMIT 5')
    const { rows: parMatiere } = await db.query(`
      SELECT matiere, SUM(nb_telechargements) as total FROM documents
      GROUP BY matiere ORDER BY total DESC LIMIT 7
    `)

    res.json({
      stats: {
        total_documents: parseInt(d[0].n),
        total_users: parseInt(u[0].n),
        total_telechargements: parseInt(t[0].n) || 0,
        commentaires_en_attente: parseInt(c[0].n),
      },
      documents,
      derniers_users,
      chartData: { labels: parMatiere.map(m => m.matiere), values: parMatiere.map(m => m.total) },
    })
  } catch (err) { next(err) }
})

// ===================== DOCUMENTS =====================

router.get('/documents', requireAdmin, async (req, res, next) => {
  try {
    const { q, cycle, statut, type_document, page = 1 } = req.query
    const limit = 10
    const offset = (parseInt(page) - 1) * limit

    let query = 'SELECT * FROM documents WHERE 1=1'
    let countQuery = 'SELECT COUNT(*) as n FROM documents WHERE 1=1'
    const params = []
    let i = 1

    if (q) { query += ` AND (titre ILIKE $${i} OR matiere ILIKE $${i})`; countQuery += ` AND (titre ILIKE $${i} OR matiere ILIKE $${i})`; params.push('%' + q + '%'); i++ }
    if (cycle) { query += ` AND cycle = $${i}`; countQuery += ` AND cycle = $${i}`; params.push(cycle); i++ }
    if (statut) { query += ` AND statut = $${i}`; countQuery += ` AND statut = $${i}`; params.push(statut); i++ }
    if (type_document) { query += ` AND type_document = $${i}`; countQuery += ` AND type_document = $${i}`; params.push(type_document); i++ }

    const { rows: countRows } = await db.query(countQuery, params)
    const total = parseInt(countRows[0].n)
    const totalPages = Math.ceil(total / limit)

    query += ` ORDER BY date_upload DESC LIMIT $${i} OFFSET $${i + 1}`
    params.push(limit, offset)
    const { rows: documents } = await db.query(query, params)

    res.json({ documents, filtres: { q, cycle, statut, type_document }, pagination: { page: parseInt(page), totalPages, total } })
  } catch (err) { next(err) }
})



// ==========================================================================
// REFERENTIELS V2 — alimentent les listes deroulantes du formulaire document
// ==========================================================================

router.get('/referentiels/categories', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, nom, slug, icone FROM categories ORDER BY ordre')
    res.json({ categories: rows })
  } catch (err) { next(err) }
})

router.get('/referentiels/examens', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT e.id, e.nom, e.type_formation
       FROM examens e
       ORDER BY e.ordre, e.nom`
    )
    res.json({ examens: rows })
  } catch (err) { next(err) }
})

router.get('/referentiels/series', requireAdmin, async (req, res, next) => {
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


router.get('/referentiels/matieres', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, nom FROM matieres ORDER BY nom')
    res.json({ matieres: rows })
  } catch (err) { next(err) }
})

router.post('/referentiels/matieres', requireAdmin, async (req, res, next) => {
  try {
    const { nom, domaine_id } = req.body
    if (!nom || !nom.trim()) return fail(res, 400, 'Le nom de la matière est obligatoire.')

    const nomPropre = nom.trim()
    const domaineIdOuNull = domaine_id || null

    const { rows: existantes } = await db.query(
      `SELECT id, nom FROM matieres
       WHERE LOWER(nom) = LOWER($1)
       AND (domaine_id = $2 OR (domaine_id IS NULL AND $2 IS NULL))`,
      [nomPropre, domaineIdOuNull]
    )
    if (existantes[0]) return res.json({ matiere: existantes[0], creee: false })

    const { rows } = await db.query(
      'INSERT INTO matieres (nom, domaine_id) VALUES ($1, $2) RETURNING id, nom',
      [nomPropre, domaineIdOuNull]
    )
    res.status(201).json({ matiere: rows[0], creee: true })
  } catch (err) { next(err) }
})

router.get('/referentiels/types-document', requireAdmin, async (req, res, next) => {
  try {
    const { categorie_id } = req.query
    const { rows } = categorie_id
      ? await db.query('SELECT id, nom FROM types_document WHERE categorie_id = $1 ORDER BY nom', [categorie_id])
      : await db.query('SELECT id, nom, categorie_id FROM types_document ORDER BY nom')
    res.json({ types: rows })
  } catch (err) { next(err) }
})

router.get('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Document introuvable.')
    res.json({ document: rows[0] })
  } catch (err) { next(err) }
})

router.post('/documents', requireAdmin, upload.single('fichier'), async (req, res, next) => {
  try {
    const {
      titre, description, niveau, annee_scolaire, statut,
      categorie_id, type_precis_id, examen_id,
      matiere_ids, serie_ids,
    } = req.body

    if (!req.file) return fail(res, 400, 'Veuillez sélectionner un fichier PDF.')
    if (!titre) return fail(res, 400, 'Le titre est obligatoire.')
    if (!categorie_id) return fail(res, 400, 'La catégorie est obligatoire.')

    const fichier_url = await uploadPDF(req.file)
    const statutFinal = statut || 'en_attente'

    // matiere_ids/serie_ids arrivent en JSON (chaine) depuis le FormData,
    // ex: "[1,3,5]" -> on les reconvertit en tableau
    const matiereIds = matiere_ids ? JSON.parse(matiere_ids) : []
    const serieIds = serie_ids ? JSON.parse(serie_ids) : []

    const { rows } = await db.query(
      `INSERT INTO documents
        (titre, description, fichier_url, niveau, annee_scolaire, admin_id, statut, actif,
         categorie_id, type_precis_id, examen_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [titre.trim(), description, fichier_url, niveau || null, annee_scolaire || null,
        req.session.admin.id, statutFinal, statutFinal === 'publie' ? 1 : 0,
        categorie_id, type_precis_id || null, examen_id || null]
    )
    const docId = rows[0].id

    for (const matiereId of matiereIds) {
      await db.query(
        'INSERT INTO document_matieres (document_id, matiere_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [docId, matiereId]
      )
    }
    for (const serieId of serieIds) {
      await db.query(
        'INSERT INTO document_series (document_id, serie_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [docId, serieId]
      )
    }
await synchroniserChampsDocument(docId)
    await logAction(req, 'creation', 'document', docId, `Création du document "${titre.trim()}" — statut: ${statutFinal}`)
    res.status(201).json({ document: rows[0] })
  } catch (err) { next(err) }
})


// Analyse un fichier et renvoie l'apercu classe, SANS RIEN ECRIRE en base
router.post('/concours/imports/apercu', requireAdmin, uploadTexte.single('fichier'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'Veuillez sélectionner un fichier.')

    const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.') + 1).toLowerCase()
    const contenu = req.file.buffer.toString('utf-8')

    const { rows: domaines } = await db.query('SELECT id, nom FROM concours.domaines ORDER BY nom')

    const questions = analyserFichier(contenu, ext, domaines)

    const resume = {
      total: questions.length,
      par_statut: questions.reduce((acc, q) => {
        acc[q.statut] = (acc[q.statut] || 0) + 1
        return acc
      }, {}),
    }

    res.json({ questions, resume, nom_fichier: req.file.originalname, format: ext })
  } catch (err) {
    if (err.message?.includes('JSON') || err.message?.includes('Format')) return fail(res, 400, err.message)
    next(err)
  }
})

// Ecrit vraiment en base les questions confirmees (eventuellement corrigees par l'admin)
router.post('/concours/imports/confirmer', requireAdmin, async (req, res, next) => {
  try {
    const { questions, nom_fichier, format } = req.body

    if (!Array.isArray(questions) || questions.length === 0) {
      return fail(res, 400, 'Aucune question à importer.')
    }

    const { rows: importRows } = await db.query(
      `INSERT INTO concours.imports (nom_fichier, format, admin_id, nb_questions_importees)
       VALUES ($1, $2, $3, 0) RETURNING id`,
      [nom_fichier || 'import', format || 'inconnu', req.session.admin.id]
    )
    const importId = importRows[0].id

    let compte = 0
    for (const q of questions) {
      const { rows: questionRows } = await db.query(
        `INSERT INTO concours.questions
          (domaine_id, type, enonce, difficulte, source, explication, reponse_texte, statut, import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          q.domaine_id || null, q.type || 'qcm', q.enonce, q.difficulte || null,
          q.source || null, q.explication || null, q.reponse_texte || null,
          q.statut || 'a_verifier', importId,
        ]
      )
      const questionId = questionRows[0].id

      if (Array.isArray(q.propositions)) {
        for (const [i, p] of q.propositions.entries()) {
          await db.query(
            'INSERT INTO concours.propositions (question_id, texte, est_correcte, ordre) VALUES ($1,$2,$3,$4)',
            [questionId, p.texte, !!p.correcte, i]
          )
        }
      }
      compte++
    }

    await db.query('UPDATE concours.imports SET nb_questions_importees = $1 WHERE id = $2', [compte, importId])

    res.status(201).json({ import_id: importId, nb_importees: compte })
  } catch (err) { next(err) }
})


router.post('/concours/imports/executer', requireAdmin, uploadTexte.single('fichier'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'Veuillez sélectionner un fichier.')
    const tailleSerie = parseInt(req.body.taille_serie) || 20

    const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.') + 1).toLowerCase()
    const contenu = req.file.buffer.toString('utf-8')
    const { rows: domaines } = await db.query('SELECT id, nom FROM concours.domaines ORDER BY nom')

    const brut = analyserFichierBrut(contenu, ext)

    const { rows: importRows } = await db.query(
      `INSERT INTO concours.imports (nom_fichier, format, admin_id, nb_questions_importees)
       VALUES ($1,$2,$3,0) RETURNING id`,
      [req.file.originalname, ext, req.session.admin.id]
    )
    const importId = importRows[0].id

    let valides = 0, erreurs = 0, rejetees = 0
    const detailErreurs = []
    const parDomaine = {}
    const domainesTouches = new Set()

        for (const qBrute of brut) {
      try {
        const verif = validerEtClasser(qBrute, domaines)
        if (verif.rejetee) {
          rejetees++
          detailErreurs.push({ enonce: (qBrute.enonce || '(vide)').slice(0, 80), erreurs: verif.erreurs })
          continue
        }
// Detection de doublon : meme enonce (normalise), meme domaine
const enonceNormalise = qBrute.enonce.trim().toLowerCase().replace(/\s+/g, ' ')
const { rows: doublonExistant } = await db.query(
  `SELECT id FROM concours.questions
   WHERE domaine_id = $1 AND LOWER(TRIM(enonce)) = $2`,
  [verif.domaine_id, enonceNormalise]
)
if (doublonExistant[0]) {
  erreurs++
  detailErreurs.push({ enonce: qBrute.enonce.slice(0, 80), erreurs: [`Doublon ignoré (déjà en base, id ${doublonExistant[0].id})`] })
  continue
}

const statut = verif.valide ? 'publiee' : 'a_verifier'
const { rows: questionRows } = await db.query(
  `INSERT INTO concours.questions (domaine_id, type, enonce, difficulte, source, explication, reponse_texte, statut, import_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  [verif.domaine_id, qBrute.type || (qBrute.propositions ? 'qcm' : 'reponse_libre'), qBrute.enonce,
    verif.difficulte, qBrute.source || null, qBrute.explication || null, qBrute.reponse_texte || null,
    statut, importId]
)
const questionId = questionRows[0].id

        if (Array.isArray(qBrute.propositions)) {
          for (const [i, p] of qBrute.propositions.entries()) {
            await db.query(
              'INSERT INTO concours.propositions (question_id, texte, est_correcte, ordre) VALUES ($1,$2,$3,$4)',
              [questionId, p.texte, !!p.correcte, i]
            )
          }
        }

        if (verif.valide) {
          valides++
          const nomDomaine = domaines.find(d => d.id === verif.domaine_id)?.nom || '?'
          domainesTouches.add(verif.domaine_id)
          parDomaine[nomDomaine] = (parDomaine[nomDomaine] || 0) + 1
        } else {
          erreurs++
          detailErreurs.push({ enonce: qBrute.enonce.slice(0, 80), erreurs: verif.erreurs })
        }
      } catch (errQuestion) {
        erreurs++
        detailErreurs.push({ enonce: (qBrute.enonce || '(vide)').slice(0, 80), erreurs: [`Erreur technique: ${errQuestion.message}`] })
      }
    }

    await db.query('UPDATE concours.imports SET nb_questions_importees = $1 WHERE id = $2', [valides, importId])

    const seriesCreees = []
    for (const domId of domainesTouches) {
      const nomDomaine = domaines.find(d => d.id === domId)?.nom || '?'
      seriesCreees.push(...(await genererSeriesAutomatiques(domId, nomDomaine, tailleSerie)))
    }

    res.status(201).json({
      total: brut.length,
      valides,
      erreurs,
      rejetees,
      par_domaine: parDomaine,
      detail_erreurs: detailErreurs.slice(0, 30),
      series_creees: seriesCreees,
    })
  } catch (err) { next(err) }
})


router.get('/concours/domaines', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, nom FROM concours.domaines WHERE actif = true ORDER BY nom')
    res.json({ domaines: rows })
  } catch (err) { next(err) }
})




router.get('/concours/questions', requireAdmin, async (req, res, next) => {
  try {
    const { statut, domaine_id, q, page = 1 } = req.query
    const limit = 20
    const offset = (parseInt(page) - 1) * limit

    let whereClause = 'WHERE 1=1'
    const params = []
    let i = 1

    if (statut) { whereClause += ` AND q.statut = $${i}`; params.push(statut); i++ }
    if (domaine_id) { whereClause += ` AND q.domaine_id = $${i}`; params.push(domaine_id); i++ }
    if (q) { whereClause += ` AND q.enonce ILIKE $${i}`; params.push(`%${q}%`); i++ }

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as n FROM concours.questions q ${whereClause}`, params
    )
    const total = parseInt(countRows[0].n)

    const { rows: questions } = await db.query(
      `SELECT q.*, d.nom AS domaine_nom,
        (SELECT json_agg(json_build_object('id', p.id, 'texte', p.texte, 'correcte', p.est_correcte) ORDER BY p.ordre)
         FROM concours.propositions p WHERE p.question_id = q.id) AS propositions
       FROM concours.questions q
       LEFT JOIN concours.domaines d ON d.id = q.domaine_id
       ${whereClause}
       ORDER BY q.date_creation DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    )

    res.json({ questions, pagination: { page: parseInt(page), total, totalPages: Math.ceil(total / limit) } })
  } catch (err) { next(err) }
})

router.put('/concours/questions/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params
    const { enonce, domaine_id, difficulte, explication, reponse_texte, statut, propositions } = req.body

    await db.query(
      `UPDATE concours.questions
       SET enonce=$1, domaine_id=$2, difficulte=$3, explication=$4, reponse_texte=$5, statut=$6
       WHERE id=$7`,
      [enonce, domaine_id || null, difficulte || null, explication || null, reponse_texte || null, statut, id]
    )

    if (Array.isArray(propositions)) {
      await db.query('DELETE FROM concours.propositions WHERE question_id = $1', [id])
      for (const [idx, p] of propositions.entries()) {
        await db.query(
          'INSERT INTO concours.propositions (question_id, texte, est_correcte, ordre) VALUES ($1,$2,$3,$4)',
          [id, p.texte, !!p.correcte, idx]
        )
      }
    }

    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/concours/questions/:id', requireAdmin, async (req, res, next) => {
  try {
    // Si la question est deja utilisee dans une serie ou une session, on
    // nettoie les liens avant de supprimer (comme pour les series_filieres)
    await db.query('DELETE FROM concours.serie_questions WHERE question_id = $1', [req.params.id])
    await db.query('DELETE FROM concours.propositions WHERE question_id = $1', [req.params.id])
    await db.query('DELETE FROM concours.questions WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.patch('/concours/questions/:id/statut', requireAdmin, async (req, res, next) => {
  try {
    const { statut } = req.body
    await db.query('UPDATE concours.questions SET statut = $1 WHERE id = $2', [statut, req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.patch('/concours/questions/:id/statut', requireAdmin, async (req, res, next) => {
  try {
    const { statut } = req.body
    await db.query('UPDATE concours.questions SET statut = $1 WHERE id = $2', [statut, req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.get('/concours/series', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, d.nom AS domaine_nom,
        (SELECT COUNT(*) FROM concours.serie_questions sq WHERE sq.serie_id = s.id) AS nb_questions_actuelles
      FROM concours.series s
      LEFT JOIN concours.domaines d ON d.id = s.domaine_id
      ORDER BY s.date_creation DESC
    `)
    res.json({ series: rows })
  } catch (err) { next(err) }
})

router.get('/concours/series/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows: serieRows } = await db.query('SELECT * FROM concours.series WHERE id = $1', [req.params.id])
    if (!serieRows[0]) return fail(res, 404, 'Série introuvable.')

    const { rows: questions } = await db.query(`
      SELECT q.id, q.enonce, q.statut, sq.ordre
      FROM concours.serie_questions sq
      JOIN concours.questions q ON q.id = sq.question_id
      WHERE sq.serie_id = $1
      ORDER BY sq.ordre
    `, [req.params.id])

    res.json({ serie: serieRows[0], questions })
  } catch (err) { next(err) }
})

router.post('/concours/series', requireAdmin, async (req, res, next) => {
  try {
    const { titre, domaine_id, description, difficulte, nb_questions_cible } = req.body
    if (!titre || !domaine_id) return fail(res, 400, 'Titre et domaine sont obligatoires.')

    const { rows } = await db.query(
      `INSERT INTO concours.series (titre, domaine_id, description, difficulte, nb_questions_cible, statut)
       VALUES ($1,$2,$3,$4,$5,'brouillon') RETURNING *`,
      [titre.trim(), domaine_id, description || null, difficulte || null, nb_questions_cible || 20]
    )
    res.status(201).json({ serie: rows[0] })
  } catch (err) { next(err) }
})

// Questions "validee" du domaine de la serie, pas encore dans cette serie -- pour le selecteur
router.get('/concours/series/:id/questions-disponibles', requireAdmin, async (req, res, next) => {
  try {
    const { rows: serieRows } = await db.query('SELECT domaine_id FROM concours.series WHERE id = $1', [req.params.id])
    if (!serieRows[0]) return fail(res, 404, 'Série introuvable.')

    const { rows } = await db.query(`
      SELECT q.id, q.enonce
      FROM concours.questions q
      WHERE q.domaine_id = $1 AND q.statut = 'validee'
        AND q.id NOT IN (SELECT question_id FROM concours.serie_questions WHERE serie_id = $2)
      ORDER BY q.date_creation DESC
    `, [serieRows[0].domaine_id, req.params.id])

    res.json({ questions: rows })
  } catch (err) { next(err) }
})

router.post('/concours/series/:id/questions', requireAdmin, async (req, res, next) => {
  try {
    const { question_ids } = req.body
    if (!Array.isArray(question_ids) || question_ids.length === 0) return fail(res, 400, 'Aucune question sélectionnée.')

    const { rows: maxOrdre } = await db.query(
      'SELECT COALESCE(MAX(ordre), -1) as m FROM concours.serie_questions WHERE serie_id = $1', [req.params.id]
    )
    let ordre = maxOrdre[0].m + 1

    for (const qid of question_ids) {
      await db.query(
        'INSERT INTO concours.serie_questions (serie_id, question_id, ordre) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [req.params.id, qid, ordre++]
      )
    }

    await majStatutSerie(req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/concours/series/:id/questions/:questionId', requireAdmin, async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM concours.serie_questions WHERE serie_id = $1 AND question_id = $2',
      [req.params.id, req.params.questionId]
    )
    await majStatutSerie(req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.put('/concours/series/:id/publier', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM concours.series WHERE id = $1', [req.params.id])
    const serie = rows[0]
    if (!serie) return fail(res, 404, 'Série introuvable.')
    if (serie.statut !== 'complete') return fail(res, 400, 'La série doit être complète (nombre de questions cible atteint) avant publication.')

    await db.query(
      `UPDATE concours.series SET statut = 'publiee', date_publication = NOW() WHERE id = $1`,
      [req.params.id]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

// Recalcule automatiquement 'incomplete'/'complete' selon le nombre de questions liees
async function majStatutSerie(serieId) {
  const { rows } = await db.query(`
    SELECT s.nb_questions_cible, s.statut,
      (SELECT COUNT(*) FROM concours.serie_questions sq WHERE sq.serie_id = s.id) AS nb_actuelles
    FROM concours.series s WHERE s.id = $1
  `, [serieId])
  const s = rows[0]
  if (!s || s.statut === 'publiee') return // ne jamais retrograder une serie deja publiee automatiquement

  const nouveauStatut = s.nb_actuelles >= s.nb_questions_cible ? 'complete' : 'incomplete'
  await db.query('UPDATE concours.series SET statut = $1 WHERE id = $2', [nouveauStatut, serieId])
}

router.put('/documents/:id', requireAdmin, upload.single('fichier'), async (req, res, next) => {
  try {
    const {
      titre, description, niveau, annee_scolaire, statut,
      categorie_id, type_precis_id, examen_id,
      matiere_ids, serie_ids,
    } = req.body
    const id = req.params.id
    const statutFinal = statut || 'publie'
    const actif = statutFinal === 'publie' ? 1 : 0

    const matiereIds = matiere_ids ? JSON.parse(matiere_ids) : []
    const serieIds = serie_ids ? JSON.parse(serie_ids) : []

    if (req.file) {
      const fichier_url = await uploadPDF(req.file)
      await db.query(
        `UPDATE documents SET titre=$1, description=$2, niveau=$3, annee_scolaire=$4,
         fichier_url=$5, statut=$6, actif=$7, categorie_id=$8, type_precis_id=$9, examen_id=$10
         WHERE id=$11`,
        [titre.trim(), description, niveau || null, annee_scolaire || null, fichier_url,
          statutFinal, actif, categorie_id, type_precis_id || null, examen_id || null, id]
      )
    } else {
      await db.query(
        `UPDATE documents SET titre=$1, description=$2, niveau=$3, annee_scolaire=$4,
         statut=$5, actif=$6, categorie_id=$7, type_precis_id=$8, examen_id=$9
         WHERE id=$10`,
        [titre.trim(), description, niveau || null, annee_scolaire || null,
          statutFinal, actif, categorie_id, type_precis_id || null, examen_id || null, id]
      )
    }

    // On repart de zero sur les liaisons N-N a chaque modification (plus simple et fiable
    // que de calculer un diff), puis on reinsere la selection actuelle
    await db.query('DELETE FROM document_matieres WHERE document_id = $1', [id])
    await db.query('DELETE FROM document_series WHERE document_id = $1', [id])
    for (const matiereId of matiereIds) {
      await db.query('INSERT INTO document_matieres (document_id, matiere_id) VALUES ($1, $2)', [id, matiereId])
    }
    for (const serieId of serieIds) {
      await db.query('INSERT INTO document_series (document_id, serie_id) VALUES ($1, $2)', [id, serieId])
    }
await synchroniserChampsDocument(id)
    await logAction(req, 'modification', 'document', id, `Modification du document "${titre.trim()}" — statut: ${statutFinal}`)
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1', [id])
    res.json({ document: rows[0] })
  } catch (err) { next(err) }
})

router.patch('/documents/:id/statut', requireAdmin, async (req, res, next) => {
  try {
    const { statut } = req.body
    const id = req.params.id
    const actif = statut === 'publie' ? 1 : 0

    const { rows } = await db.query('SELECT titre FROM documents WHERE id = $1', [id])
    await db.query('UPDATE documents SET statut = $1, actif = $2 WHERE id = $3', [statut, actif, id])
    await logAction(req, 'changement_statut', 'document', id, `Statut changé en "${statut}" pour "${rows[0]?.titre}"`)

    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT titre FROM documents WHERE id = $1', [req.params.id])
    await db.query('DELETE FROM commentaires WHERE document_id = $1', [req.params.id])
    await db.query('DELETE FROM documents WHERE id = $1', [req.params.id])
    await logAction(req, 'suppression', 'document', req.params.id, `Suppression du document "${rows[0]?.titre}"`)

    res.json({ success: true })
  } catch (err) { next(err) }
})


router.get('/documents/:id/apercu', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Document introuvable.')

    const url = await getSignedUrlAdmin(rows[0].fichier_url)
    res.json({ url, titre: rows[0].titre })
  } catch (err) { next(err) }
})

// ===================== JOURNAL =====================

router.get('/journal', requireAdmin, async (req, res, next) => {
  try {
    const { rows: actions } = await db.query(`
      SELECT a.*, adm.nom as admin_nom FROM admin_actions a
      JOIN admins adm ON a.admin_id = adm.id
      ORDER BY a.date_action DESC LIMIT 100
    `)
    res.json({ actions })
  } catch (err) { next(err) }
})

// ===================== UTILISATEURS =====================

router.get('/utilisateurs', requireAdmin, async (req, res, next) => {
  try {
    const { q, statut, page = 1 } = req.query
    const limit = 15
    const offset = (parseInt(page) - 1) * limit

    let query = 'SELECT * FROM users WHERE 1=1'
    let countQuery = 'SELECT COUNT(*) as n FROM users WHERE 1=1'
    const params = []
    let i = 1

    if (q) { query += ` AND (nom_complet ILIKE $${i} OR email ILIKE $${i})`; countQuery += ` AND (nom_complet ILIKE $${i} OR email ILIKE $${i})`; params.push('%' + q + '%'); i++ }
    if (statut) { query += ` AND statut = $${i}`; countQuery += ` AND statut = $${i}`; params.push(statut); i++ }

    const { rows: countRows } = await db.query(countQuery, params)
    const total = parseInt(countRows[0].n)
    const totalPages = Math.ceil(total / limit)

    query += ` ORDER BY date_inscription DESC LIMIT $${i} OFFSET $${i + 1}`
    params.push(limit, offset)
    const { rows: users } = await db.query(query, params)

    res.json({ users, filtres: { q, statut }, pagination: { page: parseInt(page), totalPages, total } })
  } catch (err) { next(err) }
})

router.post('/utilisateurs/:id/suspendre', requireAdmin, async (req, res, next) => {
  try {
    await db.query("UPDATE users SET statut = 'suspendu' WHERE id = $1", [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.post('/utilisateurs/:id/reactiver', requireAdmin, async (req, res, next) => {
  try {
    await db.query("UPDATE users SET statut = 'actif' WHERE id = $1", [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/utilisateurs/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM commentaires WHERE user_id = $1', [req.params.id])
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ===================== COMMENTAIRES =====================

router.get('/commentaires', requireAdmin, async (req, res, next) => {
  try {
    const { filtre = 'attente', q, page = 1 } = req.query
    const limit = 15
    const offset = (parseInt(page) - 1) * limit

    let condition = ''
    if (filtre === 'attente') condition = 'AND c.visible = 0'
    else if (filtre === 'approuves') condition = 'AND c.visible = 1'

    let search = ''
    const params = []
    let i = 1
    if (q) { search = ` AND (c.contenu ILIKE $${i} OR u.nom_complet ILIKE $${i} OR d.titre ILIKE $${i})`; params.push('%' + q + '%'); i++ }

    const countQuery = `SELECT COUNT(*) as n FROM commentaires c JOIN users u ON c.user_id = u.id JOIN documents d ON c.document_id = d.id WHERE 1=1 ${condition} ${search}`
    const { rows: countRows } = await db.query(countQuery, params)
    const total = parseInt(countRows[0].n)
    const totalPages = Math.ceil(total / limit)

    const query = `
      SELECT c.*, u.nom_complet, d.titre as titre_document
      FROM commentaires c JOIN users u ON c.user_id = u.id JOIN documents d ON c.document_id = d.id
      WHERE 1=1 ${condition} ${search}
      ORDER BY c.date_publication DESC LIMIT $${i} OFFSET $${i + 1}`
    params.push(limit, offset)
    const { rows: commentaires } = await db.query(query, params)

    const { rows: a } = await db.query('SELECT COUNT(*) as n FROM commentaires WHERE visible = 0')
    const { rows: ap } = await db.query('SELECT COUNT(*) as n FROM commentaires WHERE visible = 1')
    const { rows: tot } = await db.query('SELECT COUNT(*) as n FROM commentaires')

    res.json({
      commentaires, filtre, filtres: { q },
      stats: { attente: parseInt(a[0].n), approuves: parseInt(ap[0].n), total: parseInt(tot[0].n) },
      pagination: { page: parseInt(page), totalPages, total },
    })
  } catch (err) { next(err) }
})

router.post('/commentaires/:id/approuver', requireAdmin, async (req, res, next) => {
  try {
    await db.query('UPDATE commentaires SET visible = 1 WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.post('/commentaires/:id/masquer', requireAdmin, async (req, res, next) => {
  try {
    await db.query('UPDATE commentaires SET visible = 0 WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/commentaires/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM commentaires WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
