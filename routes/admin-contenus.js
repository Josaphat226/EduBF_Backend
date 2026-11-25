// ==========================================================================
// API ADMIN — contenus pédagogiques (exercices, devoirs, sujets d'examen)
// Monté dans server.js via :
//   app.use('/api/admin/contenus', require('./routes/admin-contenus'))
// Tables : schéma "pedagogie" (migration 029).
// Format du document : services/contenus/schema-v1.json
// ==========================================================================

const crypto = require('crypto')
const express = require('express')
const router = express.Router()
const db = require('../database/database')
const { valider, calculerEmpreinte } = require('../services/contenus/validation')
const multer = require('multer')
const supabase = require('../database/supabase')
const { preparerMedia, ErreurMedia, BUCKET_MEDIAS } = require('../services/contenus/medias')
const { supprimerPdf } = require('../services/contenus/pdf-stockage')

const TYPES = ['exercice', 'serie_exercices', 'devoir', 'composition', 'sujet_examen']
const DIFFICULTES = ['facile', 'moyen', 'difficile']
const ORIGINES = ['edubf', 'externe']
const AUTORISATIONS = ['sans_objet', 'a_verifier', 'obtenue', 'domaine_public']

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra })
}

// Erreur « attendue » : lancée dans une route, renvoyée telle quelle au client
class ErreurHttp extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const MESSAGES_CONTRAINTES = {
  ck_contenus_examen_requis: 'Un sujet d’examen doit préciser l’examen.',
  ck_contenus_source_externe: 'Un contenu externe doit citer sa source.',
  ck_contenus_droits_publication: 'Un contenu externe ne peut être publié que si l’autorisation est obtenue (ou domaine public).',
  ck_versions_note_modification: 'Une note de modification est obligatoire à partir de la version 2.',
  uq_pedagogie_versions_en_travail: 'Une version est déjà en cours de travail pour ce contenu.'
}

function gererErreur(err, res, next) {
  if (err instanceof ErreurHttp) return fail(res, err.status, err.message, err.extra)
  if (err.code === '23503') {
    return fail(res, 400, 'Une référence (niveau, matière, examen, série, chapitre…) n’existe pas ou est encore utilisée.')
  }
  if (err.constraint && MESSAGES_CONTRAINTES[err.constraint]) {
    return fail(res, err.code === '23505' ? 409 : 400, MESSAGES_CONTRAINTES[err.constraint])
  }
  // Messages levés volontairement par les triggers de la migration 029 (version figée…)
  if (err.code === '23514' && !err.constraint) return fail(res, 409, err.message)
  next(err)
}

router.use((req, res, next) => {
  if (!req.session.admin) return fail(res, 401, 'Non authentifié (admin).')
  next()
})

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return fail(res, 404, 'Contenu introuvable.')
  next()
})

router.param('numero', (req, res, next, numero) => {
  if (!/^\d+$/.test(numero)) return fail(res, 404, 'Version introuvable.')
  next()
})

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

async function transaction(fn) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const resultat = await fn(client)
    await client.query('COMMIT')
    return resultat
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function logAction(executeur, req, action, contenuId, details) {
  await executeur.query(
    'INSERT INTO admin_actions (admin_id, action, cible, cible_id, details) VALUES ($1,$2,$3,$4,$5)',
    [req.session.admin.id, action, 'contenu', contenuId, details]
  )
}

function slugifier(texte) {
  const s = String(texte)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return s || 'contenu'
}

function entierPositif(valeur) {
  const n = Number(valeur)
  return Number.isInteger(n) && n > 0 ? n : null
}

function texteOuNull(valeur) {
  const s = String(valeur ?? '').trim()
  return s || null
}

// undefined = « ne pas toucher » ; sinon liste d'identifiants entiers positifs sans doublon
function listeIds(valeur, nom) {
  if (valeur === undefined) return { valeur: undefined }
  if (!Array.isArray(valeur)) return { erreur: `${nom} doit être une liste.` }
  const ids = valeur.map(entierPositif)
  if (ids.some(x => x === null)) return { erreur: `${nom} : identifiants invalides.` }
  const uniques = [...new Set(ids)]
  if (uniques.length > 50) return { erreur: `${nom} : 50 éléments maximum.` }
  return { valeur: uniques }
}

// ----- Classes et matières saisies à la main -----
// Le formulaire peut envoyer niveau_nom / matiere_nom (texte libre) à la place d'un identifiant :
// on réutilise l'entrée existante de même nom (sans tenir compte des accents, majuscules et espaces),
// sinon on la crée. Les identifiants trouvés sont placés dans une copie du corps de la requête.
const normaliserNom = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

async function trouverOuCreer(table, nom, maxCaracteres, libelle, creer) {
  const propre = String(nom).replace(/\s+/g, ' ').trim()
  if (propre.length > maxCaracteres) throw new ErreurHttp(400, `${libelle} trop long (${maxCaracteres} caractères maximum).`)
  const cle = normaliserNom(propre)
  const { rows } = await db.query(`SELECT id, nom FROM ${table}`)
  const existant = rows.find((r) => normaliserNom(r.nom) === cle)
  if (existant) return existant.id
  return creer(propre)
}

async function resoudreClassement(body) {
  const corps = { ...body }
  const vide = (v) => v === undefined || v === null || v === ''
  const niveauNom = typeof body.niveau_nom === 'string' ? body.niveau_nom.trim() : ''
  const matiereNom = typeof body.matiere_nom === 'string' ? body.matiere_nom.trim() : ''
  if (vide(body.niveau_id) && niveauNom) {
    corps.niveau_id = await trouverOuCreer('niveaux_scolaires', niveauNom, 100, 'Nom de la classe', async (nom) => {
      const { rows } = await db.query(
        'INSERT INTO niveaux_scolaires (nom, ordre) SELECT $1, COALESCE(MAX(ordre), 0) + 1 FROM niveaux_scolaires RETURNING id', [nom])
      return rows[0].id
    })
  }
  if (vide(body.matiere_id) && matiereNom) {
    corps.matiere_id = await trouverOuCreer('matieres', matiereNom, 150, 'Nom de la matière', async (nom) => {
      const { rows } = await db.query('INSERT INTO matieres (nom) VALUES ($1) RETURNING id', [nom])
      return rows[0].id
    })
  }
  return corps
}

function squelette() {
  return {
    version_schema: 1,
    parties: [{
      id: crypto.randomUUID(),
      exercices: [{ id: crypto.randomUUID(), enonce: { type: 'doc', content: [] } }]
    }]
  }
}

// Valide et normalise les métadonnées d'un contenu (création et modification)
function lireMetadonnees(body) {
  const titre = String(body.titre || '').trim()
  if (!titre || titre.length > 255) return { erreur: 'Titre obligatoire (255 caractères maximum).' }
  if (!TYPES.includes(body.type)) return { erreur: 'Type de contenu invalide.' }

  // Le niveau (la classe) est facultatif ; la matière est obligatoire.
  // Les identifiants sont ceux de resoudreClassement() quand l'auteur a saisi un nom à la main.
  let niveau_id = null
  if (body.niveau_id !== undefined && body.niveau_id !== null && body.niveau_id !== '') {
    niveau_id = entierPositif(body.niveau_id)
    if (!niveau_id) return { erreur: 'Niveau invalide.' }
  }
  const matiere_id = entierPositif(body.matiere_id)
  if (!matiere_id) return { erreur: 'Matière obligatoire.' }

  const optionnels = {}
  for (const champ of ['examen_id', 'session_id', 'langue_id']) {
    if (body[champ] === undefined || body[champ] === null || body[champ] === '') {
      optionnels[champ] = null
    } else {
      optionnels[champ] = entierPositif(body[champ])
      if (!optionnels[champ]) return { erreur: `${champ} invalide.` }
    }
  }
  if (body.type === 'sujet_examen' && !optionnels.examen_id) {
    return { erreur: 'Un sujet d’examen doit préciser l’examen.' }
  }

  const difficulte = texteOuNull(body.difficulte)
  if (difficulte && !DIFFICULTES.includes(difficulte)) return { erreur: 'Difficulté invalide.' }

  const description = texteOuNull(body.description)
  if (description && description.length > 5000) return { erreur: 'Description trop longue (5000 caractères maximum).' }
  const annee_scolaire = texteOuNull(body.annee_scolaire)
  if (annee_scolaire && annee_scolaire.length > 20) return { erreur: 'Année scolaire trop longue (20 caractères maximum).' }

  const origine = body.origine === undefined ? 'edubf' : body.origine
  if (!ORIGINES.includes(origine)) return { erreur: 'Origine invalide.' }

  let source_nom = null, source_url = null, licence = null, autorisation = 'sans_objet', autorisation_note = null
  if (origine === 'externe') {
    source_nom = texteOuNull(body.source_nom)
    if (!source_nom) return { erreur: 'Un contenu externe doit citer sa source.' }
    if (source_nom.length > 300) return { erreur: 'Source trop longue (300 caractères maximum).' }
    source_url = texteOuNull(body.source_url)
    if (source_url && (source_url.length > 500 || !/^https?:\/\//i.test(source_url))) {
      return { erreur: 'Le lien de la source doit commencer par http:// ou https://.' }
    }
    licence = texteOuNull(body.licence)
    if (licence && licence.length > 100) return { erreur: 'Licence trop longue (100 caractères maximum).' }
    autorisation = AUTORISATIONS.includes(body.autorisation) && body.autorisation !== 'sans_objet'
      ? body.autorisation : 'a_verifier'
    autorisation_note = texteOuNull(body.autorisation_note)
    if (autorisation_note && autorisation_note.length > 1000) return { erreur: 'Note d’autorisation trop longue (1000 caractères maximum).' }
  }

  const series = listeIds(body.series_ids, 'series_ids')
  const chapitres = listeIds(body.chapitres_ids, 'chapitres_ids')
  const notions = listeIds(body.notions_ids, 'notions_ids')
  for (const l of [series, chapitres, notions]) if (l.erreur) return { erreur: l.erreur }

  return {
    valeurs: {
      type: body.type, titre, slug: slugifier(titre), description,
      niveau_id, matiere_id, ...optionnels, annee_scolaire, difficulte,
      origine, source_nom, source_url, licence, autorisation, autorisation_note
    },
    liaisons: { series_ids: series.valeur, chapitres_ids: chapitres.valeur, notions_ids: notions.valeur }
  }
}

async function remplacerLiaisons(client, contenuId, liaisons) {
  const tables = [
    ['contenu_series', 'serie_id', liaisons.series_ids],
    ['contenu_chapitres', 'chapitre_id', liaisons.chapitres_ids],
    ['contenu_notions', 'notion_id', liaisons.notions_ids]
  ]
  for (const [table, colonne, ids] of tables) {
    if (ids === undefined) continue
    await client.query(`DELETE FROM pedagogie.${table} WHERE contenu_id = $1`, [contenuId])
    if (ids.length) {
      await client.query(
        `INSERT INTO pedagogie.${table} (contenu_id, ${colonne}) SELECT $1, unnest($2::int[])`,
        [contenuId, ids]
      )
    }
  }
}

// Le document doit au moins respecter le format (JSON Schema) pour être enregistré,
// même en brouillon. Les règles métier (corrigés, points…) ne bloquent qu'à la relecture.
function exigerFormatValide(doc) {
  const verification = valider(doc)
  if (verification.resume === null) {
    throw new ErreurHttp(400, 'Le document ne respecte pas le format attendu.', { erreurs: verification.erreurs })
  }
  return verification
}

const COLONNES_CONTENU = `
  c.id, c.code, c.type, c.titre, c.slug, c.description,
  c.niveau_id, n.nom AS niveau, c.matiere_id, m.nom AS matiere,
  c.examen_id, ex.nom AS examen, c.session_id, c.annee_scolaire, c.langue_id, c.difficulte,
  c.duree_minutes, c.bareme_total,
  c.origine, c.source_nom, c.source_url, c.licence, c.autorisation, c.autorisation_note,
  c.acces_sujet, c.acces_corrige, c.version_publiee_id, c.actif,
  c.cree_par, c.relu_par, c.publie_par,
  c.date_creation, c.date_modification, c.date_publication`

const JOINTURES_CONTENU = `
  FROM pedagogie.contenus c
  LEFT JOIN niveaux_scolaires n ON n.id = c.niveau_id
  JOIN matieres m ON m.id = c.matiere_id
  LEFT JOIN examens ex ON ex.id = c.examen_id`

// ===================== RÉFÉRENTIELS (listes des formulaires) =====================

router.get('/referentiels', async (req, res, next) => {
  try {
    const [niveaux, matieres, examens, series, sessions, langues, chapitres] = await Promise.all([
      db.query('SELECT id, nom FROM niveaux_scolaires ORDER BY ordre, nom'),
      db.query('SELECT id, nom FROM matieres ORDER BY nom'),
      db.query('SELECT id, nom FROM examens ORDER BY ordre, nom'),
      db.query('SELECT id, examen_id, nom, groupe FROM series_filieres ORDER BY examen_id, ordre, nom'),
      db.query('SELECT id, nom FROM sessions_examen ORDER BY nom'),
      db.query('SELECT id, nom, code FROM langues ORDER BY nom'),
      db.query('SELECT id, niveau_id, matiere_id, serie_id, titre FROM pedagogie.chapitres WHERE actif ORDER BY niveau_id, matiere_id, ordre, titre')
    ])
    res.json({
      types: TYPES,
            medias_url_base: supabase.storage.from(BUCKET_MEDIAS).getPublicUrl('x').data.publicUrl.slice(0, -1),
      niveaux: niveaux.rows,
      matieres: matieres.rows,
      examens: examens.rows,
      series: series.rows,
      sessions: sessions.rows,
      langues: langues.rows,
      chapitres: chapitres.rows
    })
  } catch (err) { next(err) }
})


// ===================== MÉDIAS (schémas SVG, images) =====================
// Envoi d'un fichier (champ « fichier ») : contrôle du contenu, nettoyage des SVG,
// puis rangement dans le stockage sous un nom basé sur l'empreinte du fichier.
// La réponse donne le chemin à placer dans figure.attrs.src et l'adresse d'aperçu.

const televerser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } })

router.post('/medias', (req, res, next) => {
  televerser.single('fichier')(req, res, (err) => {
    if (!err) return next()
    if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'Fichier trop volumineux (2 Mo maximum).')
    return fail(res, 400, 'Envoi du fichier invalide.')
  })
}, async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'Aucun fichier reçu (champ « fichier »).')
    const media = preparerMedia(req.file.buffer)

    const { error } = await supabase.storage.from(BUCKET_MEDIAS).upload(media.chemin, media.buffer, {
      contentType: media.contentType, upsert: true, cacheControl: '31536000'
    })
    if (error) throw new Error('Envoi vers le stockage impossible : ' + error.message)

    const { data } = supabase.storage.from(BUCKET_MEDIAS).getPublicUrl(media.chemin)
    res.status(201).json({
      src: media.chemin,
      url: data.publicUrl,
      type: media.contentType,
      taille: media.buffer.length,
      retires: media.retires
    })
  } catch (err) {
    if (err instanceof ErreurMedia) return fail(res, 400, err.message)
    next(err)
  }
})


// ===================== LISTE =====================

router.get('/', async (req, res, next) => {
  try {
    const conditions = []
    const params = []
    const ajouter = (sql, valeur) => {
      params.push(valeur)
      conditions.push(sql.replace('?', '$' + params.length))
    }

    if (TYPES.includes(req.query.type)) ajouter('c.type = ?', req.query.type)
    if (entierPositif(req.query.niveau_id)) ajouter('c.niveau_id = ?', Number(req.query.niveau_id))
    if (entierPositif(req.query.matiere_id)) ajouter('c.matiere_id = ?', Number(req.query.matiere_id))
    if (req.query.q) {
      const motif = '%' + String(req.query.q).trim().replace(/[\\%_]/g, '\\$&') + '%'
      ajouter('c.titre ILIKE ?', motif)
    }
    const etats = {
      publie: 'c.version_publiee_id IS NOT NULL AND c.actif',
      brouillon: "vt.statut = 'brouillon'",
      relu: "vt.statut = 'relue'",
      depublie: 'NOT c.actif'
    }
    if (etats[req.query.etat]) conditions.push(etats[req.query.etat])

    const limite = Math.min(entierPositif(req.query.limit) || 50, 200)
    const decalage = Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) > 0 ? Number(req.query.offset) : 0
    params.push(limite, decalage)

    const { rows } = await db.query(
      `SELECT c.id, c.code, c.type, c.titre, c.niveau_id, n.nom AS niveau, c.matiere_id, m.nom AS matiere,
              ex.nom AS examen, c.origine, c.actif, c.date_creation, c.date_modification, c.date_publication,
              vp.numero AS version_publiee, vt.numero AS version_travail, vt.statut AS statut_travail,
              vp.pdf_statut, COUNT(*) OVER() AS total
                FROM pedagogie.contenus c
         LEFT JOIN niveaux_scolaires n ON n.id = c.niveau_id
         JOIN matieres m ON m.id = c.matiere_id
         LEFT JOIN examens ex ON ex.id = c.examen_id
         LEFT JOIN pedagogie.versions vp ON vp.id = c.version_publiee_id
         LEFT JOIN pedagogie.versions vt ON vt.contenu_id = c.id AND vt.statut IN ('brouillon', 'relue')
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY c.date_modification DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    const total = rows.length ? Number(rows[0].total) : 0
    res.json({ total, contenus: rows.map(({ total: _t, ...r }) => r) })
  } catch (err) { next(err) }
})

// ===================== CRÉATION =====================

router.post('/', async (req, res, next) => {
  try {
    const { erreur, valeurs: v, liaisons } = lireMetadonnees(await resoudreClassement(req.body))
    if (erreur) return fail(res, 400, erreur)

    const doc = req.body.contenu_json === undefined ? squelette() : req.body.contenu_json
    const verification = exigerFormatValide(doc)

    const contenu = await transaction(async (client) => {
      const adminId = req.session.admin.id
      const { rows } = await client.query(
        `INSERT INTO pedagogie.contenus
           (type, titre, slug, description, niveau_id, matiere_id, examen_id, session_id, annee_scolaire,
            langue_id, difficulte, origine, source_nom, source_url, licence, autorisation, autorisation_note, cree_par)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id, code`,
        [v.type, v.titre, v.slug, v.description, v.niveau_id, v.matiere_id, v.examen_id, v.session_id,
         v.annee_scolaire, v.langue_id, v.difficulte, v.origine, v.source_nom, v.source_url, v.licence,
         v.autorisation, v.autorisation_note, adminId]
      )
      const cree = rows[0]
      await remplacerLiaisons(client, cree.id, liaisons)
      await client.query(
        'INSERT INTO pedagogie.versions (contenu_id, numero, contenu_json, cree_par) VALUES ($1, 1, $2, $3)',
        [cree.id, JSON.stringify(doc), adminId]
      )
      await logAction(client, req, 'creation', cree.id, `Création du contenu « ${v.titre} » (${v.type})`)
      return cree
    })

    res.status(201).json({
      id: contenu.id,
      code: contenu.code,
      verification: { erreurs: verification.erreurs, avertissements: verification.avertissements, resume: verification.resume }
    })
  } catch (err) { gererErreur(err, res, next) }
})

// ===================== LECTURE =====================

router.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id
    const { rows } = await db.query(`SELECT ${COLONNES_CONTENU} ${JOINTURES_CONTENU} WHERE c.id = $1`, [id])
    if (!rows[0]) return fail(res, 404, 'Contenu introuvable.')

    const [series, chapitres, notions, versions, travail] = await Promise.all([
      db.query('SELECT serie_id FROM pedagogie.contenu_series WHERE contenu_id = $1 ORDER BY serie_id', [id]),
      db.query(
        `SELECT ch.id, ch.titre FROM pedagogie.contenu_chapitres cc
           JOIN pedagogie.chapitres ch ON ch.id = cc.chapitre_id WHERE cc.contenu_id = $1 ORDER BY ch.ordre, ch.titre`, [id]),
      db.query(
        `SELECT nt.id, nt.titre FROM pedagogie.contenu_notions cn
           JOIN pedagogie.notions nt ON nt.id = cn.notion_id WHERE cn.contenu_id = $1 ORDER BY nt.ordre, nt.titre`, [id]),
      db.query(
        `SELECT numero, statut, note_modification, date_creation, date_relecture, date_publication,
                pdf_statut, pdf_sujet_url IS NOT NULL AS pdf_sujet_pret, pdf_corrige_url IS NOT NULL AS pdf_corrige_pret
           FROM pedagogie.versions WHERE contenu_id = $1 ORDER BY numero DESC`, [id]),
      db.query(
        `SELECT numero, statut, note_modification, contenu_json
           FROM pedagogie.versions WHERE contenu_id = $1 AND statut IN ('brouillon', 'relue')`, [id])
    ])

    res.json({
      contenu: rows[0],
      series_ids: series.rows.map(r => r.serie_id),
      chapitres: chapitres.rows,
      notions: notions.rows,
      versions: versions.rows,
      version_travail: travail.rows[0] || null
    })
  } catch (err) { next(err) }
})

// Une version précise (lecture seule), y compris publiée ou archivée
router.get('/:id/versions/:numero', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT numero, statut, note_modification, schema_version, empreinte, contenu_json,
              date_creation, date_relecture, date_publication, pdf_statut
         FROM pedagogie.versions WHERE contenu_id = $1 AND numero = $2`,
      [req.params.id, req.params.numero]
    )
    if (!rows[0]) return fail(res, 404, 'Version introuvable.')
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ===================== MODIFICATION DES MÉTADONNÉES =====================
// (classement, source, droits ; le contenu du sujet se modifie via /:id/brouillon)

router.put('/:id', async (req, res, next) => {
  try {
    const { erreur, valeurs: v, liaisons } = lireMetadonnees(req.body)
    if (erreur) return fail(res, 400, erreur)

    await transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE pedagogie.contenus SET
           type=$2, titre=$3, slug=$4, description=$5, niveau_id=$6, matiere_id=$7, examen_id=$8, session_id=$9,
           annee_scolaire=$10, langue_id=$11, difficulte=$12, origine=$13, source_nom=$14, source_url=$15,
           licence=$16, autorisation=$17, autorisation_note=$18, date_modification=now()
         WHERE id = $1`,
        [req.params.id, v.type, v.titre, v.slug, v.description, v.niveau_id, v.matiere_id, v.examen_id, v.session_id,
         v.annee_scolaire, v.langue_id, v.difficulte, v.origine, v.source_nom, v.source_url, v.licence,
         v.autorisation, v.autorisation_note]
      )
      if (!rowCount) throw new ErreurHttp(404, 'Contenu introuvable.')
      await remplacerLiaisons(client, req.params.id, liaisons)
      await logAction(client, req, 'modification', req.params.id, `Modification des informations du contenu « ${v.titre} »`)
    })
    res.json({ success: true })
  } catch (err) { gererErreur(err, res, next) }
})

// ===================== VERSION EN COURS DE TRAVAIL =====================

// Retourne la version brouillon/relue du contenu (avec quelques infos du contenu),
// ou lance 404 (contenu inconnu) / 409 (aucune version en cours).
async function versionDeTravail(executeur, contenuId) {
  const { rows } = await executeur.query(
    `SELECT c.titre, c.origine, c.autorisation, v.id, v.numero, v.statut, v.contenu_json
       FROM pedagogie.contenus c
       LEFT JOIN pedagogie.versions v ON v.contenu_id = c.id AND v.statut IN ('brouillon', 'relue')
      WHERE c.id = $1`,
    [contenuId]
  )
  if (!rows[0]) throw new ErreurHttp(404, 'Contenu introuvable.')
  if (!rows[0].id) throw new ErreurHttp(409, 'Aucune version en cours de travail : créez d’abord une nouvelle version.')
  return rows[0]
}

// Enregistrer le brouillon (sauvegarde de l'éditeur).
// Le format doit être valide ; les règles métier ne bloquent pas : elles sont renvoyées pour affichage.
// Modifier une version déjà relue la repasse en brouillon (la relecture ne vaut plus).
router.put('/:id/brouillon', async (req, res, next) => {
  try {
    if (req.body.contenu_json === undefined) return fail(res, 400, 'contenu_json est obligatoire.')
    const verification = exigerFormatValide(req.body.contenu_json)
    const note = texteOuNull(req.body.note_modification)
    if (note && note.length > 1000) return fail(res, 400, 'Note de modification trop longue (1000 caractères maximum).')

    const numero = await transaction(async (client) => {
      const version = await versionDeTravail(client, req.params.id)
      await client.query(
        `UPDATE pedagogie.versions
            SET contenu_json = $2, schema_version = 1, statut = 'brouillon',
                relue_par = NULL, date_relecture = NULL,
                note_modification = COALESCE($3, note_modification)
          WHERE id = $1`,
        [version.id, JSON.stringify(req.body.contenu_json), note]
      )
      await client.query('UPDATE pedagogie.contenus SET date_modification = now() WHERE id = $1', [req.params.id])
      return version.numero
    })

    res.json({
      numero,
      statut: 'brouillon',
      verification: { erreurs: verification.erreurs, avertissements: verification.avertissements, resume: verification.resume }
    })
  } catch (err) { gererErreur(err, res, next) }
})

// Nouvelle version (n+1) à partir de la version publiée — ou, à défaut, de la dernière.
router.post('/:id/versions', async (req, res, next) => {
  try {
    const note = texteOuNull(req.body.note_modification)
    if (!note || note.length < 5) return fail(res, 400, 'Indiquez ce qui change (5 caractères minimum).')
    if (note.length > 1000) return fail(res, 400, 'Note de modification trop longue (1000 caractères maximum).')

    const numero = await transaction(async (client) => {
      const verrou = await client.query('SELECT id FROM pedagogie.contenus WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!verrou.rowCount) throw new ErreurHttp(404, 'Contenu introuvable.')

      const enCours = await client.query(
        "SELECT numero FROM pedagogie.versions WHERE contenu_id = $1 AND statut IN ('brouillon', 'relue')",
        [req.params.id]
      )
      if (enCours.rowCount) {
        throw new ErreurHttp(409, `La version ${enCours.rows[0].numero} est déjà en cours de travail.`)
      }

      const source = await client.query(
        `SELECT v.contenu_json, v.schema_version
           FROM pedagogie.versions v JOIN pedagogie.contenus c ON c.id = v.contenu_id
          WHERE c.id = $1
          ORDER BY (v.id = c.version_publiee_id) DESC, v.numero DESC
          LIMIT 1`,
        [req.params.id]
      )
      if (!source.rowCount) throw new ErreurHttp(409, 'Ce contenu n’a aucune version à copier.')

      const { rows } = await client.query(
        `INSERT INTO pedagogie.versions (contenu_id, numero, contenu_json, schema_version, note_modification, cree_par)
         VALUES ($1, (SELECT COALESCE(MAX(numero), 0) + 1 FROM pedagogie.versions WHERE contenu_id = $1), $2, $3, $4, $5)
         RETURNING numero`,
        [req.params.id, JSON.stringify(source.rows[0].contenu_json), source.rows[0].schema_version, note, req.session.admin.id]
      )
      await client.query('UPDATE pedagogie.contenus SET date_modification = now() WHERE id = $1', [req.params.id])
      await logAction(client, req, 'nouvelle_version', req.params.id, `Version ${rows[0].numero} : ${note}`)
      return rows[0].numero
    })

    res.status(201).json({ numero, statut: 'brouillon' })
  } catch (err) { gererErreur(err, res, next) }
})

// Vérifier la version en cours avec les règles de publication, sans rien modifier.
router.post('/:id/valider', async (req, res, next) => {
  try {
    const version = await versionDeTravail(db, req.params.id)
    const verification = valider(version.contenu_json, { pourPublication: true })
    res.json({ numero: version.numero, statut: version.statut, ...verification })
  } catch (err) { gererErreur(err, res, next) }
})

// ===================== RELECTURE ET PUBLICATION =====================

router.post('/:id/relire', async (req, res, next) => {
  try {
    const resultat = await transaction(async (client) => {
      const version = await versionDeTravail(client, req.params.id)
      if (version.statut === 'relue') throw new ErreurHttp(409, 'Cette version est déjà relue : vous pouvez la publier.')

      const verification = valider(version.contenu_json, { pourPublication: true })
      if (!verification.ok) {
        throw new ErreurHttp(422, 'Corrigez les erreurs avant de valider la relecture.', {
          erreurs: verification.erreurs, avertissements: verification.avertissements
        })
      }

      await client.query(
        "UPDATE pedagogie.versions SET statut = 'relue', relue_par = $2, date_relecture = now() WHERE id = $1",
        [version.id, req.session.admin.id]
      )
      await client.query(
        'UPDATE pedagogie.contenus SET relu_par = $2, date_modification = now() WHERE id = $1',
        [req.params.id, req.session.admin.id]
      )
      await logAction(client, req, 'relecture', req.params.id, `Version ${version.numero} relue — « ${version.titre} »`)
      return { numero: version.numero, avertissements: verification.avertissements, resume: verification.resume }
    })
    res.json({ statut: 'relue', ...resultat })
  } catch (err) { gererErreur(err, res, next) }
})

router.post('/:id/publier', async (req, res, next) => {
  try {
    let anciensPdf = [] // PDF de la version qui va être remplacée : à supprimer du stockage après la publication
    const resultat = await transaction(async (client) => {
      // Verrou : deux publications simultanées du même contenu sont impossibles
      const verrou = await client.query('SELECT id FROM pedagogie.contenus WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!verrou.rowCount) throw new ErreurHttp(404, 'Contenu introuvable.')

      const version = await versionDeTravail(client, req.params.id)
      if (version.statut !== 'relue') throw new ErreurHttp(409, 'La version doit d’abord être relue.')

      if (version.origine === 'externe' && !['obtenue', 'domaine_public'].includes(version.autorisation)) {
        throw new ErreurHttp(422, 'Contenu externe : l’autorisation doit être « obtenue » ou « domaine public » avant publication.')
      }

      // Dernière vérification (le contenu a pu changer depuis la relecture)
      const verification = valider(version.contenu_json, { pourPublication: true })
      if (!verification.ok) {
        throw new ErreurHttp(422, 'Le contenu ne peut pas être publié en l’état.', { erreurs: verification.erreurs })
      }

      const empreinte = calculerEmpreinte(version.contenu_json)
      const adminId = req.session.admin.id

          const ancien = await client.query(
        "SELECT pdf_sujet_url, pdf_corrige_url FROM pedagogie.versions WHERE contenu_id = $1 AND statut = 'publiee'", [req.params.id])
      anciensPdf = ancien.rows.flatMap((r) => [r.pdf_sujet_url, r.pdf_corrige_url])
      await client.query(
        `UPDATE pedagogie.versions
            SET statut = 'archivee', pdf_sujet_url = NULL, pdf_corrige_url = NULL, pdf_statut = 'aucun'
          WHERE contenu_id = $1 AND statut = 'publiee'`, [req.params.id])
      await client.query(
        `UPDATE pedagogie.versions
            SET statut = 'publiee', empreinte = $2, publiee_par = $3, date_publication = now(),
                pdf_statut = 'aucun', pdf_erreur = NULL, pdf_tentatives = 0
          WHERE id = $1`,
        [version.id, empreinte, adminId]
      )
      const total = verification.resume.total_points
      const { rows } = await client.query(
        `UPDATE pedagogie.contenus
            SET version_publiee_id = $2, publie_par = $3, date_publication = COALESCE(date_publication, now()),
                date_modification = now(), duree_minutes = $4, bareme_total = $5, actif = true
          WHERE id = $1
          RETURNING code`,
        [req.params.id, version.id, adminId, verification.resume.duree_minutes, total > 0 ? total : null]
      )
      await logAction(client, req, 'publication', req.params.id, `Publication de la version ${version.numero} — « ${version.titre} »`)
      return { code: rows[0].code, numero: version.numero, avertissements: verification.avertissements }
    })
       await supprimerPdf(anciensPdf)
    res.json({ statut: 'publiee', pdf_statut: 'aucun', ...resultat })
  } catch (err) { gererErreur(err, res, next) }
})

// Dépublier / remettre en ligne (le contenu et ses versions sont conservés)
router.patch('/:id/actif', async (req, res, next) => {
  try {
    if (typeof req.body.actif !== 'boolean') return fail(res, 400, '« actif » doit être vrai ou faux.')
    const { rows } = await db.query('SELECT titre, version_publiee_id FROM pedagogie.contenus WHERE id = $1', [req.params.id])
    if (!rows[0]) return fail(res, 404, 'Contenu introuvable.')
    if (req.body.actif && !rows[0].version_publiee_id) return fail(res, 409, 'Ce contenu n’a jamais été publié.')

    await db.query('UPDATE pedagogie.contenus SET actif = $2, date_modification = now() WHERE id = $1', [req.params.id, req.body.actif])
        if (!req.body.actif && rows[0].version_publiee_id) {
      // Dépublication : les PDF sont supprimés du stockage ; à la remise en ligne, l'outil les refabriquera
      const pdf = await db.query(
        `UPDATE pedagogie.versions v
            SET pdf_sujet_url = NULL, pdf_corrige_url = NULL, pdf_statut = 'aucun', pdf_tentatives = 0, pdf_erreur = NULL
           FROM pedagogie.versions o
          WHERE v.id = o.id AND v.id = $1
        RETURNING o.pdf_sujet_url AS ancien_sujet, o.pdf_corrige_url AS ancien_corrige`,
        [rows[0].version_publiee_id]
      )
      await supprimerPdf(pdf.rows.flatMap((r) => [r.ancien_sujet, r.ancien_corrige]))
    }
    await logAction(db, req, req.body.actif ? 'remise_en_ligne' : 'depublication', req.params.id, `« ${rows[0].titre} »`)
    res.json({ actif: req.body.actif })
  } catch (err) { gererErreur(err, res, next) }
})

// Suppression : un contenu jamais publié, ou déjà retiré (il faut d'abord le retirer)
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.titre, c.actif,
              EXISTS (SELECT 1 FROM pedagogie.versions v
                       WHERE v.contenu_id = c.id AND v.statut IN ('publiee', 'archivee')) AS deja_publie
         FROM pedagogie.contenus c WHERE c.id = $1`,
      [req.params.id]
    )
    if (!rows[0]) return fail(res, 404, 'Contenu introuvable.')
    if (rows[0].deja_publie && rows[0].actif) return fail(res, 409, 'Ce contenu est en ligne : retirez-le d’abord, puis supprimez-le.')

    // On note les PDF avant de supprimer, pour les effacer du stockage ensuite
    const pdf = await db.query('SELECT pdf_sujet_url, pdf_corrige_url FROM pedagogie.versions WHERE contenu_id = $1', [req.params.id])
    await db.query('DELETE FROM pedagogie.contenus WHERE id = $1', [req.params.id])
    await supprimerPdf(pdf.rows.flatMap((r) => [r.pdf_sujet_url, r.pdf_corrige_url]))
    await logAction(db, req, 'suppression', req.params.id, `Suppression du contenu « ${rows[0].titre} »`)
    res.json({ success: true })
  } catch (err) { gererErreur(err, res, next) }
})

module.exports = router