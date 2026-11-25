// ==========================================================================
// API PUBLIQUE — lecture des contenus pédagogiques publiés
// Monté dans server.js via :
//   app.use('/api/contenus', require('./routes/contenus-public'))
// (à placer AVANT la ligne app.use('/api', require('./routes/api')))
//
// Ne renvoie que la version PUBLIÉE d'un contenu actif. Les brouillons, versions
// relues, versions archivées et contenus dépubliés sont invisibles ici.
// ==========================================================================

const express = require('express')
const router = express.Router()
const db = require('../database/database')
const supabase = require('../database/supabase')
const { BUCKET_MEDIAS } = require('../services/contenus/medias')
const { slugifier } = require('../services/contenus/slug')

const TYPES = ['exercice', 'serie_exercices', 'devoir', 'composition', 'sujet_examen']

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}

// Alphabet de pedagogie.generer_code() : sans 0, O, 1, I, L
const FORMAT_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/

router.param('code', (req, res, next, code) => {
  const normalise = String(code).trim().toUpperCase() // un code recopié à la main peut être en minuscules
  if (!FORMAT_CODE.test(normalise)) return fail(res, 404, 'Contenu introuvable.')
  req.params.code = normalise
  next()
})

// Ajoute à chaque figure l'adresse publique de son image (attrs.url).
// Le chemin (attrs.src) a déjà été validé à l'enregistrement : contenus/<sha256>.<ext>
function ajouterUrlsFigures(valeur) {
  if (Array.isArray(valeur)) return valeur.forEach(ajouterUrlsFigures)
  if (!valeur || typeof valeur !== 'object') return
  if (valeur.type === 'figure' && valeur.attrs && typeof valeur.attrs.src === 'string') {
    valeur.attrs.url = supabase.storage.from(BUCKET_MEDIAS).getPublicUrl(valeur.attrs.src).data.publicUrl
  }
  Object.values(valeur).forEach(ajouterUrlsFigures)
}

// ===================== LISTE, FILTRES ET RECHERCHE =====================
// GET /api/contenus?niveau=3e&matiere=mathematiques&examen=bepc&type=devoir&q=racines&page=2
//   niveau, matiere, examen : adresses lisibles (nom sans accents ni majuscules)
//   par_page : 1 à 50 (50 par défaut : le sitemap parcourt la liste par pages de 50)
//   facettes=1 : ajoute, pour chaque filtre, les choix possibles avec leur nombre de résultats
//                (calculés en tenant compte des AUTRES filtres choisis : pas d'impasse)

const TTL_REFERENTIEL_MS = 60 * 1000
let cacheReferentiel = { date: 0, valeur: null }

async function chargerReferentiel() {
  if (cacheReferentiel.valeur && Date.now() - cacheReferentiel.date < TTL_REFERENTIEL_MS) return cacheReferentiel.valeur
  const [niveaux, matieres, examens] = await Promise.all([
    db.query('SELECT id, nom FROM niveaux_scolaires'),
    db.query('SELECT id, nom FROM matieres'),
    db.query('SELECT id, nom FROM examens')
  ])
  const avecSlug = (rows) => rows.map(r => ({ id: r.id, nom: r.nom, slug: slugifier(r.nom) }))
  cacheReferentiel = { date: Date.now(), valeur: { niveaux: avecSlug(niveaux.rows), matieres: avecSlug(matieres.rows), examens: avecSlug(examens.rows) } }
  return cacheReferentiel.valeur
}

// Un filtre demandé mais inconnu ne doit pas être ignoré (on afficherait tout) : il donne zéro résultat.
function resoudre(liste, slug) {
  if (!slug) return { slug: null, id: null, nom: null, inconnu: false }
  const trouve = liste.find(x => x.slug === slugifier(slug))
  return trouve ? { slug: trouve.slug, id: trouve.id, nom: trouve.nom, inconnu: false } : { slug: String(slug).slice(0, 80), id: null, nom: null, inconnu: true }
}

// Construit la clause WHERE à partir des filtres, en pouvant en exclure un (pour les facettes)
function clauseWhere(f, exclure) {
  const conditions = ['c.actif', 'c.version_publiee_id IS NOT NULL']
  const params = []
  const ajouter = (sql, ...valeurs) => {
    let i = 0
    conditions.push(sql.replace(/\?/g, () => { params.push(valeurs[i++]); return '$' + params.length }))
  }
  if (exclure !== 'niveau' && f.niveau.slug) ajouter('c.niveau_id = ?', f.niveau.id)
  if (exclure !== 'matiere' && f.matiere.slug) ajouter('c.matiere_id = ?', f.matiere.id)
  if (exclure !== 'examen' && f.examen.slug) ajouter('c.examen_id = ?', f.examen.id)
  if (exclure !== 'type' && f.type) ajouter('c.type = ?', f.type)
  if (f.q) ajouter("(c.recherche @@ websearch_to_tsquery('french', ?) OR c.titre ILIKE ?)", f.q, '%' + f.q.replace(/[\\%_]/g, '\\$&') + '%')
  return { where: conditions.join(' AND '), params }
}

async function facettes(f) {
  const requete = async (exclure, sql) => {
    const { where, params } = clauseWhere(f, exclure)
    return (await db.query(sql.replace('__WHERE__', where), params)).rows
  }
  const [niveaux, matieres, examens, types] = await Promise.all([
    requete('niveau', `SELECT n.nom, n.ordre, COUNT(*)::int AS n FROM pedagogie.contenus c JOIN niveaux_scolaires n ON n.id = c.niveau_id
                       WHERE __WHERE__ GROUP BY n.id, n.nom, n.ordre ORDER BY n.ordre, n.nom`),
    requete('matiere', `SELECT m.nom, COUNT(*)::int AS n FROM pedagogie.contenus c JOIN matieres m ON m.id = c.matiere_id
                        WHERE __WHERE__ GROUP BY m.id, m.nom ORDER BY m.nom`),
    requete('examen', `SELECT ex.nom, ex.ordre, COUNT(*)::int AS n FROM pedagogie.contenus c JOIN examens ex ON ex.id = c.examen_id
                       WHERE __WHERE__ GROUP BY ex.id, ex.nom, ex.ordre ORDER BY ex.ordre, ex.nom`),
    requete('type', `SELECT c.type AS valeur, COUNT(*)::int AS n FROM pedagogie.contenus c
                     WHERE __WHERE__ GROUP BY c.type`)
  ])
  const avecSlug = (rows) => rows.map(r => ({ slug: slugifier(r.nom), nom: r.nom, n: r.n }))
  // Le choix déjà sélectionné reste visible (pour pouvoir le retirer) même s'il n'a plus de résultat
  const garder = (liste, choisi) => (choisi.slug && choisi.nom && !liste.some(x => x.slug === choisi.slug) ? [...liste, { slug: choisi.slug, nom: choisi.nom, n: 0 }] : liste)
  return {
    niveaux: garder(avecSlug(niveaux), f.niveau),
    matieres: garder(avecSlug(matieres), f.matiere),
    examens: garder(avecSlug(examens), f.examen),
    types: TYPES.map(t => ({ valeur: t, n: (types.find(x => x.valeur === t) || { n: 0 }).n })).filter(t => t.n > 0 || t.valeur === f.type)
  }
}

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const parPage = Math.min(50, Math.max(1, parseInt(req.query.par_page, 10) || 50))
    const ref = await chargerReferentiel()
    const q = String(req.query.q || '').trim().slice(0, 100)
    const f = {
      niveau: resoudre(ref.niveaux, req.query.niveau),
      matiere: resoudre(ref.matieres, req.query.matiere),
      examen: resoudre(ref.examens, req.query.examen),
      type: TYPES.includes(req.query.type) ? req.query.type : null,
      q: q || null
    }
    const typeInconnu = req.query.type && !f.type
        // Tri : liste blanche (jamais de texte du visiteur dans le SQL)
    const TRIS = {
      recent: 'c.date_publication DESC, c.id DESC',
      ancien: 'c.date_publication ASC, c.id ASC',
      titre: 'c.titre ASC, c.id ASC'
    }
    const tri = Object.hasOwn(TRIS, req.query.tri) ? req.query.tri : 'recent'
    const impossible = f.niveau.inconnu || f.matiere.inconnu || f.examen.inconnu || typeInconnu

    let rows = []
    if (!impossible) {
      const { where, params } = clauseWhere(f)
      rows = (await db.query(
        `SELECT c.code, c.type, c.titre, LEFT(c.description, 200) AS description,
                n.nom AS niveau, m.nom AS matiere, ex.nom AS examen,
                c.duree_minutes, c.bareme_total, c.date_publication, c.date_modification, COUNT(*) OVER() AS total
           FROM pedagogie.contenus c
                    LEFT JOIN niveaux_scolaires n ON n.id = c.niveau_id
           JOIN matieres m ON m.id = c.matiere_id
           LEFT JOIN examens ex ON ex.id = c.examen_id
          WHERE ${where}
                  ORDER BY ${TRIS[tri]}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parPage, (page - 1) * parPage]
      )).rows
    }
    const total = rows.length ? Number(rows[0].total) : 0
        if (f.q && page === 1 && !impossible && !(req.session && req.session.admin)) enregistrerRecherche(f.q, total, 'exercices')
    const reponse = {
      contenus: rows.map(({ total: _t, ...r }) => r),
      pagination: { page, totalPages: Math.max(1, Math.ceil(total / parPage)), total },
      selection: {
        niveau: f.niveau.slug ? { slug: f.niveau.slug, nom: f.niveau.nom } : null,
        matiere: f.matiere.slug ? { slug: f.matiere.slug, nom: f.matiere.nom } : null,
        examen: f.examen.slug ? { slug: f.examen.slug, nom: f.examen.nom } : null,
                type: f.type, q: f.q, tri
      }
    }
    if (req.query.facettes === '1') reponse.facettes = await facettes(f)
    res.json(reponse)
  } catch (err) { next(err) }
})

// ===================== LECTURE D'UN CONTENU =====================

router.get('/:code', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.code, c.type, c.titre, c.description, c.annee_scolaire, c.difficulte,
              c.duree_minutes, c.bareme_total, c.origine, c.source_nom, c.source_url, c.licence,
              c.date_publication,
              n.nom AS niveau, m.nom AS matiere, ex.nom AS examen,
              v.numero, v.date_publication AS version_date, v.contenu_json,
              CASE WHEN v.pdf_statut = 'pret' THEN v.pdf_sujet_url END AS pdf_sujet,
              CASE WHEN v.pdf_statut = 'pret' THEN v.pdf_corrige_url END AS pdf_corrige
         FROM pedagogie.contenus c
         JOIN pedagogie.versions v ON v.id = c.version_publiee_id
                  LEFT JOIN niveaux_scolaires n ON n.id = c.niveau_id
         JOIN matieres m ON m.id = c.matiere_id
         LEFT JOIN examens ex ON ex.id = c.examen_id
        WHERE c.code = $1 AND c.actif`,
      [req.params.code]
    )
    if (!rows[0]) return fail(res, 404, 'Contenu introuvable.')
    const c = rows[0]

    const [chapitres, series] = await Promise.all([
      db.query(
        `SELECT ch.titre FROM pedagogie.contenu_chapitres cc
           JOIN pedagogie.chapitres ch ON ch.id = cc.chapitre_id
          WHERE cc.contenu_id = $1 ORDER BY ch.ordre, ch.titre`, [c.id]),
      db.query(
        `SELECT s.nom FROM pedagogie.contenu_series cs
           JOIN series_filieres s ON s.id = cs.serie_id
          WHERE cs.contenu_id = $1 ORDER BY s.ordre, s.nom`, [c.id])
    ])

    const document = c.contenu_json
    ajouterUrlsFigures(document)

    res.json({
      contenu: {
        code: c.code, type: c.type, titre: c.titre, description: c.description,
        niveau: c.niveau, matiere: c.matiere, examen: c.examen,
        annee_scolaire: c.annee_scolaire, difficulte: c.difficulte,
        duree_minutes: c.duree_minutes, bareme_total: c.bareme_total,
        origine: c.origine, source_nom: c.source_nom, source_url: c.source_url, licence: c.licence,
        date_publication: c.date_publication,
        chapitres: chapitres.rows.map(r => r.titre),
        series: series.rows.map(r => r.nom),
        version: { numero: c.numero, date_publication: c.version_date },
        pdf: { sujet: c.pdf_sujet || null, corrige: c.pdf_corrige || null }
      },
      document
    })
  } catch (err) { next(err) }
})

// ===================== SUIVI DES CONSULTATIONS =====================
// Appelé par le navigateur : à l'arrivée sur la page (vue_sujet) et à la première
// ouverture d'un corrigé (vue_corrige). Les téléchargements seront enregistrés par
// les routes de téléchargement elles-mêmes.

const TYPES_EVENEMENT = ['vue_sujet', 'vue_corrige', 'telechargement_sujet', 'telechargement_corrige']
const FENETRE_MS = 30 * 60 * 1000
const dejaVus = new Map() // clé -> horodatage ; évite de compter 10 fois un même visiteur qui actualise

// Marque le visiteur et renvoie true s'il l'était déjà (dans les 30 dernières minutes)
function dejaCompte(cle) {
  const maintenant = Date.now()
  if (dejaVus.size > 5000) {
    for (const [k, t] of dejaVus) if (maintenant - t > FENETRE_MS) dejaVus.delete(k)
    if (dejaVus.size > 5000) dejaVus.clear()
  }
  const precedent = dejaVus.get(cle)
  if (precedent && maintenant - precedent < FENETRE_MS) return true
  dejaVus.set(cle, maintenant)
  return false
}

router.post('/:code/evenements', async (req, res, next) => {
  let cle = null
  try {
    const type = req.body && req.body.type
    if (!TYPES_EVENEMENT.includes(type)) return fail(res, 400, 'Type d’évènement invalide.')
    if (req.session && req.session.admin) return res.status(204).end() // les passages de l'administrateur ne sont jamais comptés
    const userId = req.session && req.session.user ? req.session.user.id : null
    const visiteur = userId ? `u${userId}` : `ip${req.ip}`
    cle = `${visiteur}|${req.params.code}|${type}`
    // Le visiteur est marqué AVANT l'écriture (deux requêtes simultanées ne comptent qu'une fois)...
    if (dejaCompte(cle)) return res.status(204).end()

    const { rowCount } = await db.query(
      `INSERT INTO pedagogie.evenements (contenu_id, version_id, user_id, type)
       SELECT c.id, c.version_publiee_id, $2, $3
         FROM pedagogie.contenus c
        WHERE c.code = $1 AND c.actif AND c.version_publiee_id IS NOT NULL`,
      [req.params.code, userId, type]
    )
    if (!rowCount) {
      dejaVus.delete(cle) // ...mais la marque est retirée si le contenu n'existe pas (ou plus)
      return fail(res, 404, 'Contenu introuvable.')
    }
    res.status(204).end()
  } catch (err) {
    if (cle) dejaVus.delete(cle) // ou si l'écriture a échoué
    next(err)
  }
})

module.exports = router