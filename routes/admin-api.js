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

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}

// Auth admin requise (session)
function requireAdmin(req, res, next) {
  if (!req.session.admin) return fail(res, 401, 'Non authentifié (admin).')
  next()
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true)
    else cb(new Error('Seuls les fichiers PDF sont acceptés.'))
  },
})

async function uploadPDF(file) {
  const filename = Date.now() + '-' + file.originalname.replace(/\s/g, '-').replace(/[^a-zA-Z0-9.\-_]/g, '')
  const { error } = await supabase.storage.from('documents').upload(filename, file.buffer, { contentType: 'application/pdf' })
  if (error) throw new Error('Erreur upload fichier : ' + error.message)
  const { data } = supabase.storage.from('documents').getPublicUrl(filename)
  return data.publicUrl
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

    req.session.admin = { id: admin.id, nom: admin.nom, email: admin.email }
    res.json({ admin: req.session.admin })
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

router.get('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Document introuvable.')
    res.json({ document: rows[0] })
  } catch (err) { next(err) }
})

router.post('/documents', requireAdmin, upload.single('fichier'), async (req, res, next) => {
  try {
    const { titre, description, niveau, cycle, serie_filiere, matiere, type_document, annee_scolaire, statut } = req.body
    if (!req.file) return fail(res, 400, 'Veuillez sélectionner un fichier PDF.')
    if (!titre) return fail(res, 400, 'Le titre est obligatoire.')

    const fichier_url = await uploadPDF(req.file)
    const statutFinal = statut || 'en_attente'

    const { rows } = await db.query(
      `INSERT INTO documents
        (titre, description, fichier_url, niveau, cycle, serie_filiere, matiere, type_document, annee_scolaire, admin_id, statut, actif)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [titre.trim(), description, fichier_url, niveau, cycle, serie_filiere || null,
        matiere, type_document, annee_scolaire || null, req.session.admin.id,
        statutFinal, statutFinal === 'publie' ? 1 : 0]
    )

    await logAction(req, 'creation', 'document', rows[0].id, `Création du document "${titre.trim()}" — statut: ${statutFinal}`)
    res.status(201).json({ document: rows[0] })
  } catch (err) { next(err) }
})

router.put('/documents/:id', requireAdmin, upload.single('fichier'), async (req, res, next) => {
  try {
    const { titre, description, niveau, cycle, serie_filiere, matiere, type_document, annee_scolaire, statut } = req.body
    const id = req.params.id
    const statutFinal = statut || 'publie'
    const actif = statutFinal === 'publie' ? 1 : 0

    if (req.file) {
      const fichier_url = await uploadPDF(req.file)
      await db.query(
        `UPDATE documents SET titre=$1, description=$2, niveau=$3, cycle=$4,
         serie_filiere=$5, matiere=$6, type_document=$7, annee_scolaire=$8,
         fichier_url=$9, statut=$10, actif=$11 WHERE id=$12`,
        [titre.trim(), description, niveau, cycle, serie_filiere || null, matiere, type_document, annee_scolaire || null, fichier_url, statutFinal, actif, id]
      )
    } else {
      await db.query(
        `UPDATE documents SET titre=$1, description=$2, niveau=$3, cycle=$4,
         serie_filiere=$5, matiere=$6, type_document=$7, annee_scolaire=$8,
         statut=$9, actif=$10 WHERE id=$11`,
        [titre.trim(), description, niveau, cycle, serie_filiere || null, matiere, type_document, annee_scolaire || null, statutFinal, actif, id]
      )
    }

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
