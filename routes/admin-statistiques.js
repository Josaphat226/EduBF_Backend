// ==========================================================================
// API ADMIN — statistiques globales (visiteurs, utilisateurs, contenus, recherches, concours)
// Monté dans server.js AVANT '/api/admin' :
//   app.use('/api/admin/statistiques', require('./routes/admin-statistiques'))
// Les données de visites viennent de la table "visites" (migration 031) : elles commencent
// à partir du jour où le suivi est activé.
// ==========================================================================
const express = require('express')
const router = express.Router()
const db = require('../database/database')

router.use((req, res, next) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Non authentifié (admin).' })
  next()
})

const nombre = (v) => parseInt(v, 10) || 0
const jourIso = (d) => new Date(d).toISOString().substring(0, 10)
// Période : liste blanche (jamais de texte du visiteur dans le SQL). $1 = nombre de jours.
const periode = (req) => [7, 30, 90, 365].includes(parseInt(req.query.jours, 10)) ? parseInt(req.query.jours, 10) : 30
const DEPUIS = `now() - ($1::int * interval '1 day')`
const JOURS = `generate_series(current_date - ($1::int - 1), current_date, interval '1 day')`

// ---------------------------------------------------------------- Vue d'ensemble
router.get('/apercu', async (req, res, next) => {
  try {
    const j = periode(req)
    const [tot, sess, fidele, serie, heures, appareils, sources, pages, enLigne, depuisQuand, dl] = await Promise.all([
      db.query(`SELECT COUNT(DISTINCT visiteur_id) AS visiteurs, COUNT(DISTINCT session_id) AS visites, COUNT(*) AS pages,
                       COUNT(DISTINCT visiteur_id) FILTER (WHERE user_id IS NOT NULL) AS connectes
                  FROM visites WHERE created_at >= ${DEPUIS}`, [j]),
      db.query(`SELECT COUNT(*) AS n, COALESCE(AVG(t), 0) AS temps, COUNT(*) FILTER (WHERE p = 1) AS rebonds, COALESCE(AVG(p), 0) AS pages
                  FROM (SELECT session_id, SUM(secondes) AS t, COUNT(*) AS p FROM visites WHERE created_at >= ${DEPUIS} GROUP BY session_id) s`, [j]),
      db.query(`SELECT COUNT(*) FILTER (WHERE premiere < ${DEPUIS}) AS anciens, COUNT(*) FILTER (WHERE premiere >= ${DEPUIS}) AS nouveaux
                  FROM (SELECT visiteur_id, MIN(created_at) AS premiere FROM visites
                         WHERE visiteur_id IN (SELECT visiteur_id FROM visites WHERE created_at >= ${DEPUIS}) GROUP BY visiteur_id) v`, [j]),
      db.query(`SELECT d::date AS jour, COUNT(DISTINCT v.visiteur_id) AS visiteurs, COUNT(DISTINCT v.session_id) AS visites, COUNT(v.id) AS pages
                  FROM ${JOURS} d LEFT JOIN visites v ON v.created_at::date = d::date GROUP BY d ORDER BY d`, [j]),
      db.query(`SELECT EXTRACT(hour FROM created_at)::int AS h, COUNT(DISTINCT session_id) AS n FROM visites WHERE created_at >= ${DEPUIS} GROUP BY h`, [j]),
      db.query(`SELECT appareil AS nom, COUNT(DISTINCT visiteur_id) AS n FROM visites WHERE created_at >= ${DEPUIS} GROUP BY appareil ORDER BY n DESC`, [j]),
      db.query(`SELECT source AS nom, COUNT(*) AS n FROM (SELECT DISTINCT ON (session_id) source FROM visites WHERE created_at >= ${DEPUIS} ORDER BY session_id, created_at) s
                 WHERE source <> 'interne' GROUP BY source ORDER BY n DESC LIMIT 8`, [j]),
      db.query(`SELECT chemin, COUNT(*) AS vues, COUNT(DISTINCT visiteur_id) AS visiteurs, ROUND(AVG(secondes)) AS temps
                  FROM visites WHERE created_at >= ${DEPUIS} GROUP BY chemin ORDER BY vues DESC LIMIT 12`, [j]),
      db.query(`SELECT COUNT(DISTINCT visiteur_id) AS n FROM visites WHERE vu_a > now() - interval '2 minutes'`),
      db.query(`SELECT MIN(created_at) AS debut FROM visites`),
      db.query(`SELECT (SELECT COALESCE(SUM(nb_telechargements), 0) FROM documents) AS docs_total,
                       (SELECT COUNT(*) FROM user_actions WHERE action = 'telechargement' AND created_at >= ${DEPUIS}) AS docs_periode,
                       (SELECT COUNT(*) FROM pedagogie.evenements WHERE type IN ('telechargement_sujet','telechargement_corrige') AND created_at >= ${DEPUIS}) AS exos_periode`, [j]),
    ])
    const parHeure = Array.from({ length: 24 }, (_, h) => ({ h, n: nombre((heures.rows.find((r) => r.h === h) || {}).n) }))
    const nbSessions = nombre(sess.rows[0].n)
    res.json({
      jours: j,
      suivi_depuis: depuisQuand.rows[0].debut ? jourIso(depuisQuand.rows[0].debut) : null,
      en_ligne: nombre(enLigne.rows[0].n),
      resume: {
        visiteurs: nombre(tot.rows[0].visiteurs), visites: nombre(tot.rows[0].visites), pages: nombre(tot.rows[0].pages),
        connectes: nombre(tot.rows[0].connectes),
        temps_moyen: Math.round(Number(sess.rows[0].temps) || 0),
        pages_par_visite: Math.round((Number(sess.rows[0].pages) || 0) * 10) / 10,
        taux_rebond: nbSessions ? Math.round((nombre(sess.rows[0].rebonds) / nbSessions) * 100) : 0,
        nouveaux: nombre(fidele.rows[0].nouveaux), anciens: nombre(fidele.rows[0].anciens),
      },
      telechargements: { documents_total: nombre(dl.rows[0].docs_total), documents_periode: nombre(dl.rows[0].docs_periode), exercices_periode: nombre(dl.rows[0].exos_periode) },
      serie: serie.rows.map((r) => ({ jour: jourIso(r.jour), visiteurs: nombre(r.visiteurs), visites: nombre(r.visites), pages: nombre(r.pages) })),
      heures: parHeure,
      appareils: appareils.rows.map((r) => ({ nom: r.nom, n: nombre(r.n) })),
      sources: sources.rows.map((r) => ({ nom: r.nom, n: nombre(r.n) })),
      pages: pages.rows.map((r) => ({ chemin: r.chemin, vues: nombre(r.vues), visiteurs: nombre(r.visiteurs), temps: nombre(r.temps) })),
    })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------- Utilisateurs
router.get('/utilisateurs', async (req, res, next) => {
  try {
    const j = periode(req)
    const [tot, serie, classes, filieres, actifs, top, retour] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE date_inscription >= ${DEPUIS}) AS nouveaux FROM users`, [j]),
      db.query(`SELECT d::date AS jour, COUNT(u.id) AS n FROM ${JOURS} d LEFT JOIN users u ON u.date_inscription::date = d::date GROUP BY d ORDER BY d`, [j]),
      db.query(`SELECT COALESCE(NULLIF(TRIM(classe), ''), 'Non renseignée') AS nom, COUNT(*) AS n FROM users GROUP BY 1 ORDER BY n DESC LIMIT 10`),
      db.query(`SELECT COALESCE(NULLIF(TRIM(filiere), ''), 'Non renseignée') AS nom, COUNT(*) AS n FROM users GROUP BY 1 ORDER BY n DESC LIMIT 10`),
      db.query(`SELECT COUNT(DISTINCT user_id) AS n FROM visites WHERE user_id IS NOT NULL AND created_at >= ${DEPUIS}`, [j]),
      db.query(`SELECT u.id, u.nom_complet, u.classe, COUNT(DISTINCT v.session_id) AS visites, COUNT(*) AS pages,
                       COALESCE(SUM(v.secondes), 0) AS secondes, MAX(v.created_at) AS dernier
                  FROM visites v JOIN users u ON u.id = v.user_id WHERE v.created_at >= ${DEPUIS}
                 GROUP BY u.id ORDER BY secondes DESC, pages DESC LIMIT 15`, [j]),
      db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE s >= 2) AS reviennent
                  FROM (SELECT visiteur_id, COUNT(DISTINCT session_id) AS s FROM visites WHERE created_at >= ${DEPUIS} GROUP BY visiteur_id) v`, [j]),
    ])
    res.json({
      jours: j,
      resume: { total: nombre(tot.rows[0].total), nouveaux: nombre(tot.rows[0].nouveaux), actifs: nombre(actifs.rows[0].n),
                visiteurs: nombre(retour.rows[0].total), reviennent: nombre(retour.rows[0].reviennent) },
      serie: serie.rows.map((r) => ({ jour: jourIso(r.jour), n: nombre(r.n) })),
      classes: classes.rows.map((r) => ({ nom: r.nom, n: nombre(r.n) })),
      filieres: filieres.rows.map((r) => ({ nom: r.nom, n: nombre(r.n) })),
      top: top.rows.map((r) => ({ id: r.id, nom: r.nom_complet, classe: r.classe, visites: nombre(r.visites), pages: nombre(r.pages), secondes: nombre(r.secondes), dernier: r.dernier })),
    })
  } catch (err) { next(err) }
})

// Fiche d'un utilisateur (réservée à l'admin)
router.get('/utilisateurs/:id', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Utilisateur introuvable.' })
    const id = req.params.id
    const { rows: u } = await db.query(`SELECT id, nom_complet, email, classe, filiere, date_inscription FROM users WHERE id = $1`, [id])
    if (!u.length) return res.status(404).json({ error: 'Utilisateur introuvable.' })
    const [resume, pages, actions, docs, divers, concours] = await Promise.all([
      db.query(`SELECT COUNT(DISTINCT session_id) AS visites, COUNT(*) AS pages, COALESCE(SUM(secondes), 0) AS secondes, MAX(created_at) AS dernier FROM visites WHERE user_id = $1`, [id]),
      db.query(`SELECT chemin, secondes, created_at FROM visites WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`, [id]),
      db.query(`SELECT action, COUNT(*) AS n FROM user_actions WHERE user_id = $1 GROUP BY action ORDER BY n DESC`, [id]),
      db.query(`SELECT d.id, d.titre, COUNT(*) AS n FROM user_actions ua JOIN documents d ON d.id = ua.document_id WHERE ua.user_id = $1 GROUP BY d.id, d.titre ORDER BY n DESC LIMIT 8`, [id]),
      db.query(`SELECT (SELECT COUNT(*) FROM favoris WHERE user_id = $1) AS favoris, (SELECT COUNT(*) FROM commentaires WHERE user_id = $1) AS commentaires`, [id]),
      db.query(`SELECT COUNT(*) AS seances, COUNT(*) FILTER (WHERE statut = 'terminee') AS terminees,
                       ROUND(100 * AVG(score::float / NULLIF(nb_questions, 0)) FILTER (WHERE statut = 'terminee')) AS moyenne
                  FROM concours.sessions WHERE user_id = $1`, [id]),
    ])
    res.json({
      utilisateur: u[0],
      resume: { visites: nombre(resume.rows[0].visites), pages: nombre(resume.rows[0].pages), secondes: nombre(resume.rows[0].secondes), dernier: resume.rows[0].dernier },
      pages: pages.rows,
      actions: actions.rows.map((r) => ({ action: r.action, n: nombre(r.n) })),
      documents: docs.rows.map((r) => ({ id: r.id, titre: r.titre, n: nombre(r.n) })),
      favoris: nombre(divers.rows[0].favoris), commentaires: nombre(divers.rows[0].commentaires),
      concours: { seances: nombre(concours.rows[0].seances), terminees: nombre(concours.rows[0].terminees), moyenne: concours.rows[0].moyenne == null ? null : nombre(concours.rows[0].moyenne) },
    })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------- Contenus (documents PDF + exercices corrigés)
router.get('/contenus', async (req, res, next) => {
  try {
    const j = periode(req)
    const [docsVus, docsDl, categories, exos, jamais, interactions] = await Promise.all([
      db.query(`SELECT d.id, d.titre, c.nom AS categorie, COUNT(*) AS vues, COUNT(DISTINCT v.visiteur_id) AS visiteurs,
                       ROUND(AVG(v.secondes)) AS temps, d.nb_telechargements,
                       (SELECT COUNT(*) FROM favoris f WHERE f.document_id = d.id) AS favoris
                  FROM visites v JOIN documents d ON v.chemin = '/documents/' || d.id
                  LEFT JOIN categories c ON c.id = d.categorie_id
                 WHERE v.created_at >= ${DEPUIS} GROUP BY d.id, d.titre, c.nom, d.nb_telechargements ORDER BY vues DESC LIMIT 10`, [j]),
      db.query(`SELECT d.id, d.titre, c.nom AS categorie, d.nb_telechargements FROM documents d LEFT JOIN categories c ON c.id = d.categorie_id
                 WHERE d.nb_telechargements > 0 ORDER BY d.nb_telechargements DESC LIMIT 10`),
      db.query(`SELECT COALESCE(c.nom, 'Sans catégorie') AS nom, COUNT(*) AS n
                  FROM visites v JOIN documents d ON v.chemin = '/documents/' || d.id LEFT JOIN categories c ON c.id = d.categorie_id
                 WHERE v.created_at >= ${DEPUIS} GROUP BY 1 ORDER BY n DESC LIMIT 8`, [j]),
      db.query(`SELECT c.code, c.titre, m.nom AS matiere,
                       COUNT(*) FILTER (WHERE e.type = 'vue_sujet') AS vues,
                       COUNT(*) FILTER (WHERE e.type = 'vue_corrige') AS corriges,
                       COUNT(*) FILTER (WHERE e.type IN ('telechargement_sujet','telechargement_corrige')) AS telechargements
                  FROM pedagogie.evenements e JOIN pedagogie.contenus c ON c.id = e.contenu_id JOIN matieres m ON m.id = c.matiere_id
                 WHERE e.created_at >= ${DEPUIS} GROUP BY c.id, c.code, c.titre, m.nom ORDER BY vues DESC, telechargements DESC LIMIT 10`, [j]),
      db.query(`SELECT (SELECT COUNT(*) FROM documents d WHERE d.actif = 1 AND NOT EXISTS
                         (SELECT 1 FROM visites v WHERE v.chemin = '/documents/' || d.id AND v.created_at >= ${DEPUIS})) AS documents,
                       (SELECT COUNT(*) FROM pedagogie.contenus c WHERE c.actif AND c.version_publiee_id IS NOT NULL AND NOT EXISTS
                         (SELECT 1 FROM pedagogie.evenements e WHERE e.contenu_id = c.id AND e.type = 'vue_sujet' AND e.created_at >= ${DEPUIS})) AS exercices`, [j]),
      db.query(`SELECT (SELECT COUNT(*) FROM favoris WHERE date_ajout >= ${DEPUIS}) AS favoris,
                       (SELECT COUNT(*) FROM commentaires WHERE date_publication >= ${DEPUIS}) AS commentaires,
                       (SELECT COUNT(*) FROM user_actions WHERE action = 'telechargement' AND created_at >= ${DEPUIS}) AS telechargements_inscrits,
                       (SELECT COALESCE(SUM(nb_telechargements), 0) FROM documents) AS telechargements_total,
                       (SELECT COUNT(*) FROM documents WHERE actif = 1) AS documents_publies`, [j]),
    ])
    res.json({
      jours: j,
      resume: {
        documents_publies: nombre(interactions.rows[0].documents_publies), telechargements_total: nombre(interactions.rows[0].telechargements_total),
        telechargements_inscrits: nombre(interactions.rows[0].telechargements_inscrits),
        favoris: nombre(interactions.rows[0].favoris), commentaires: nombre(interactions.rows[0].commentaires),
        documents_jamais_vus: nombre(jamais.rows[0].documents), exercices_jamais_vus: nombre(jamais.rows[0].exercices),
      },
      documents_vus: docsVus.rows.map((r) => ({ id: r.id, titre: r.titre, categorie: r.categorie, vues: nombre(r.vues), visiteurs: nombre(r.visiteurs), temps: nombre(r.temps), telechargements: nombre(r.nb_telechargements), favoris: nombre(r.favoris) })),
      documents_telecharges: docsDl.rows.map((r) => ({ id: r.id, titre: r.titre, categorie: r.categorie, telechargements: nombre(r.nb_telechargements) })),
      categories: categories.rows.map((r) => ({ nom: r.nom, n: nombre(r.n) })),
      exercices: exos.rows.map((r) => ({ code: r.code, titre: r.titre, matiere: r.matiere, vues: nombre(r.vues), corriges: nombre(r.corriges), telechargements: nombre(r.telechargements) })),
    })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------- Recherches
router.get('/recherche', async (req, res, next) => {
  try {
    const j = periode(req)
    const [tot, top, vides] = await Promise.all([
      db.query(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE nb_resultats = 0) AS sans FROM recherches WHERE created_at >= ${DEPUIS}`, [j]),
      db.query(`SELECT terme, origine, COUNT(*) AS n, ROUND(AVG(nb_resultats)) AS resultats FROM recherches
                 WHERE created_at >= ${DEPUIS} GROUP BY terme, origine ORDER BY n DESC, terme LIMIT 15`, [j]),
      db.query(`SELECT terme, origine, COUNT(*) AS n FROM recherches WHERE nb_resultats = 0 AND created_at >= ${DEPUIS}
                 GROUP BY terme, origine ORDER BY n DESC, terme LIMIT 15`, [j]),
    ])
    res.json({
      jours: j,
      resume: { recherches: nombre(tot.rows[0].n), sans_resultat: nombre(tot.rows[0].sans) },
      top: top.rows.map((r) => ({ terme: r.terme, origine: r.origine, n: nombre(r.n), resultats: nombre(r.resultats) })),
      sans_resultat: vides.rows.map((r) => ({ terme: r.terme, origine: r.origine, n: nombre(r.n) })),
    })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------- Concours (QCM)
router.get('/concours', async (req, res, next) => {
  try {
    const j = periode(req)
    const [tot, serie, domaines, ratees] = await Promise.all([
      db.query(`SELECT COUNT(*) AS lancees, COUNT(*) FILTER (WHERE statut = 'terminee') AS terminees, COUNT(DISTINCT user_id) AS participants,
                       ROUND(100 * AVG(score::float / NULLIF(nb_questions, 0)) FILTER (WHERE statut = 'terminee')) AS moyenne
                  FROM concours.sessions WHERE date_debut >= ${DEPUIS}`, [j]),
      db.query(`SELECT d::date AS jour, COUNT(s.id) AS n FROM ${JOURS} d LEFT JOIN concours.sessions s ON s.date_debut::date = d::date GROUP BY d ORDER BY d`, [j]),
      db.query(`SELECT dm.nom, COUNT(rs.id) AS reponses, ROUND(100.0 * AVG(rs.correcte::int)) AS reussite
                  FROM concours.reponses_session rs
                  JOIN concours.session_questions sq ON sq.id = rs.session_question_id
                  JOIN concours.questions q ON q.id = sq.question_id
                  JOIN concours.domaines dm ON dm.id = q.domaine_id
                 WHERE rs.date_reponse >= ${DEPUIS} GROUP BY dm.nom ORDER BY reponses DESC LIMIT 12`, [j]),
      db.query(`SELECT LEFT(q.enonce, 120) AS enonce, dm.nom AS domaine, COUNT(*) AS reponses, ROUND(100.0 * AVG(rs.correcte::int)) AS reussite
                  FROM concours.reponses_session rs
                  JOIN concours.session_questions sq ON sq.id = rs.session_question_id
                  JOIN concours.questions q ON q.id = sq.question_id
                  JOIN concours.domaines dm ON dm.id = q.domaine_id
                 WHERE rs.date_reponse >= ${DEPUIS} GROUP BY q.id, q.enonce, dm.nom HAVING COUNT(*) >= 3
                 ORDER BY reussite ASC, reponses DESC LIMIT 10`, [j]),
    ])
    const lancees = nombre(tot.rows[0].lancees)
    res.json({
      jours: j,
      resume: { lancees, terminees: nombre(tot.rows[0].terminees), participants: nombre(tot.rows[0].participants),
                taux_achevement: lancees ? Math.round((nombre(tot.rows[0].terminees) / lancees) * 100) : 0,
                moyenne: tot.rows[0].moyenne == null ? null : nombre(tot.rows[0].moyenne) },
      serie: serie.rows.map((r) => ({ jour: jourIso(r.jour), n: nombre(r.n) })),
      domaines: domaines.rows.map((r) => ({ nom: r.nom, reponses: nombre(r.reponses), reussite: nombre(r.reussite) })),
      ratees: ratees.rows.map((r) => ({ enonce: r.enonce, domaine: r.domaine, reponses: nombre(r.reponses), reussite: nombre(r.reussite) })),
    })
  } catch (err) { next(err) }
})

module.exports = router