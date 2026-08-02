/**
 * MOTEUR DE RECOMMANDATION EDUBF
 * Inspiré du modèle TikTok : score basé sur les actions + profil + popularité
 *
 * Poids des actions (du plus faible au plus fort) :
 * vue=1, lecture=3, téléchargement=5, commentaire=7, favori=10
 */

const db = require('./database')

// ===== POIDS DES ACTIONS =====
const POIDS = {
  vue: 1,
  lecture: 3,
  telechargement: 5,
  commentaire: 7,
  favori: 10
}

// ===== ENREGISTRE UNE ACTION =====
async function enregistrerAction(userId, documentId, action, dureeSecondes = 0) {
  try {
    if (!userId || !documentId) return

    // Évite les doublons de vues rapprochées (moins de 5 minutes)
    if (action === 'vue') {
      const { rows } = await db.query(
        `SELECT id FROM user_actions
         WHERE user_id = $1 AND document_id = $2 AND action = 'vue'
         AND created_at > NOW() - INTERVAL '5 minutes'`,
        [userId, documentId]
      )
      if (rows.length > 0) return
    }

    await db.query(
      'INSERT INTO user_actions (user_id, document_id, action, duree_secondes) VALUES ($1, $2, $3, $4)',
      [userId, documentId, action, dureeSecondes]
    )

    // Recalcule le score en arrière-plan (non bloquant)
    recalculerScore(userId, documentId).catch(() => {})

  } catch (err) {
    console.error('Erreur enregistrerAction:', err.message)
  }
}

// ===== RECALCULE LE SCORE POUR UN USER + DOCUMENT =====
async function recalculerScore(userId, documentId) {
  try {
    // Récupère toutes les actions de cet utilisateur sur ce document
    const { rows: actions } = await db.query(
      'SELECT action, duree_secondes FROM user_actions WHERE user_id = $1 AND document_id = $2',
      [userId, documentId]
    )

    let score = 0
    for (const a of actions) {
      score += (POIDS[a.action] || 1)
      // Bonus si l'utilisateur a passé du temps sur le document
      if (a.duree_secondes > 30) score += 1
      if (a.duree_secondes > 120) score += 2
    }

    // Sauvegarde le score
    await db.query(
      `INSERT INTO recommendation_scores (user_id, document_id, score, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, document_id)
       DO UPDATE SET score = $3, updated_at = NOW()`,
      [userId, documentId, score]
    )
  } catch (err) {
    console.error('Erreur recalculerScore:', err.message)
  }
}

// ===== ALGORITHME PRINCIPAL DE RECOMMANDATION =====
async function getRecommandations(userId, options = {}) {
  const { limite = 6, exclureDejaVus = false } = options

  try {
    // 1. Récupère le profil de l'utilisateur
    const { rows: userRows } = await db.query(
      'SELECT filiere_preferee FROM users WHERE id = $1', [userId]
    )
    const user = userRows[0]
    const filiereUser = user?.filiere_preferee || null

    // 2. Documents déjà vus/téléchargés par l'utilisateur
    const { rows: dejaSeen } = await db.query(
      `SELECT DISTINCT document_id FROM user_actions WHERE user_id = $1`,
      [userId]
    )
    const dejaSeenIds = dejaSeen.map(r => r.document_id)

    // 3. Analyse les préférences de l'utilisateur
    // (matières, cycles et types de documents les plus consultés)
    const { rows: preferences } = await db.query(
      `SELECT d.matiere, d.cycle, d.type_document,
              SUM(COALESCE(w.poids, 1)) as score_total
       FROM user_actions ua
       JOIN documents d ON ua.document_id = d.id
       CROSS JOIN LATERAL (
         SELECT CASE ua.action
           WHEN 'vue' THEN 1
           WHEN 'lecture' THEN 3
           WHEN 'telechargement' THEN 5
           WHEN 'commentaire' THEN 7
           WHEN 'favori' THEN 10
           ELSE 1
         END as poids
       ) w
       WHERE ua.user_id = $1
       GROUP BY d.matiere, d.cycle, d.type_document
       ORDER BY score_total DESC
       LIMIT 5`,
      [userId]
    )

    // 4. Construit la requête de recommandation intelligente
    // Combine : score personnel + filière + popularité + fraîcheur
    let excludeClause = dejaSeenIds.length > 0 && exclureDejaVus
      ? `AND d.id NOT IN (${dejaSeenIds.join(',')})` : ''

    // Matières préférées
    const matieresPreferees = [...new Set(preferences.map(p => p.matiere))].slice(0, 3)
    const cyclesPreferres = [...new Set(preferences.map(p => p.cycle))].slice(0, 2)

    // Score composite :
    // - Score personnel sauvegardé (actions passées)
    // - Bonus filière (+20 si même filière)
    // - Bonus matière préférée (+15)
    // - Bonus cycle préféré (+10)
    // - Bonus popularité (nb téléchargements / 10, max 20)
    // - Bonus fraîcheur (documents récents)
    // - Malus si déjà vu (-5)

    const matieresSQL = matieresPreferees.length > 0
      ? `WHEN d.matiere IN (${matieresPreferees.map((_, i) => `$${i + 2}`).join(',')}) THEN 15`
      : 'WHEN FALSE THEN 0'

    const cyclesSQL = cyclesPreferres.length > 0
      ? `WHEN d.cycle IN (${cyclesPreferres.map((_, i) => `$${i + 2 + matieresPreferees.length}`).join(',')}) THEN 10`
      : 'WHEN FALSE THEN 0'

    const queryParams = [userId, ...matieresPreferees, ...cyclesPreferres]

    const { rows: recommandations } = await db.query(
      `SELECT d.*,
        COALESCE(rs.score, 0)
        + CASE WHEN d.serie_filiere ILIKE $1_filiere OR d.cycle ILIKE $1_filiere THEN 20 ELSE 0 END
        + CASE ${matieresSQL} ELSE 0 END
        + CASE ${cyclesSQL} ELSE 0 END
        + LEAST(d.nb_telechargements::float / 10, 20)
        + CASE WHEN d.date_upload > NOW() - INTERVAL '30 days' THEN 8 ELSE 0 END
        + CASE WHEN d.date_upload > NOW() - INTERVAL '7 days' THEN 5 ELSE 0 END
        - CASE WHEN ua_seen.document_id IS NOT NULL THEN 5 ELSE 0 END
        AS score_final
       FROM documents d
       LEFT JOIN recommendation_scores rs ON rs.document_id = d.id AND rs.user_id = $1
       LEFT JOIN LATERAL (
         SELECT document_id FROM user_actions
         WHERE user_id = $1 AND document_id = d.id LIMIT 1
       ) ua_seen ON TRUE
       WHERE d.actif = 1 ${excludeClause}
       ORDER BY score_final DESC
       LIMIT $${queryParams.length + 1}`,
      [...queryParams, limite]
    ).catch(() => ({ rows: [] }))

    // Fallback si la requête complexe échoue
    if (recommandations.length === 0) {
      return await getFallback(userId, limite)
    }

    return recommandations

  } catch (err) {
    console.error('Erreur getRecommandations:', err.message)
    return await getFallback(userId, limite)
  }
}

// ===== FALLBACK : recommandations simples si algo échoue =====
async function getFallback(userId, limite = 6) {
  try {
    const { rows: userRows } = await db.query(
      'SELECT filiere_preferee FROM users WHERE id = $1', [userId]
    )
    const filiere = userRows[0]?.filiere_preferee

    let query = 'SELECT * FROM documents WHERE actif = 1'
    const params = []

    if (filiere) {
      query += ' ORDER BY CASE WHEN serie_filiere ILIKE $1 OR cycle ILIKE $1 THEN 0 ELSE 1 END, nb_telechargements DESC'
      params.push('%' + filiere + '%')
    } else {
      query += ' ORDER BY nb_telechargements DESC'
    }

    query += ` LIMIT $${params.length + 1}`
    params.push(limite)

    const { rows } = await db.query(query, params)
    return rows
  } catch (err) {
    console.error('Erreur getFallback:', err.message)
    return []
  }
}

// ===== RECOMMANDATIONS POUR VISITEUR (non connecté) =====
async function getRecommandationsVisiteur(limite = 6) {
  try {
    // Pour les visiteurs : documents populaires récents
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE actif = 1
       ORDER BY
         (nb_telechargements * 0.7) +
         (CASE WHEN date_upload > NOW() - INTERVAL '30 days' THEN 20 ELSE 0 END) +
         (CASE WHEN date_upload > NOW() - INTERVAL '7 days' THEN 10 ELSE 0 END)
       DESC LIMIT $1`,
      [limite]
    )
    return rows
  } catch (err) {
    console.error('Erreur getRecommandationsVisiteur:', err.message)
    return []
  }
}

// ===== DOCUMENTS SIMILAIRES =====
async function getDocumentsSimilaires(documentId, limite = 4) {
  try {
    const { rows: doc } = await db.query(
      'SELECT cycle, matiere, serie_filiere, type_document FROM documents WHERE id = $1',
      [documentId]
    )
    if (!doc[0]) return []

    const { cycle, matiere, serie_filiere } = doc[0]

    const { rows } = await db.query(
      `SELECT *, (
        CASE WHEN matiere = $2 THEN 10 ELSE 0 END +
        CASE WHEN cycle = $3 THEN 5 ELSE 0 END +
        CASE WHEN serie_filiere = $4 THEN 8 ELSE 0 END +
        LEAST(nb_telechargements::float / 10, 10)
      ) as score
       FROM documents
       WHERE actif = 1 AND id != $1
       ORDER BY score DESC, nb_telechargements DESC
       LIMIT $5`,
      [documentId, matiere, cycle, serie_filiere, limite]
    )
    return rows
  } catch (err) {
    console.error('Erreur getDocumentsSimilaires:', err.message)
    return []
  }
}

module.exports = {
  enregistrerAction,
  getRecommandations,
  getRecommandationsVisiteur,
  getDocumentsSimilaires,
  recalculerScore
}



async function getRecommandations(userId, options = {}) {
  const { limite = 6, exclureDejaVus = false } = options

  try {
    // 1. Récupère le profil complet de l'utilisateur
    const { rows: userRows } = await db.query(
      'SELECT filiere_preferee, filiere, classe FROM users WHERE id = $1', [userId]
    )
    const user = userRows[0]
    const filiere = user?.filiere || user?.filiere_preferee || null
    const classe = user?.classe || null

    // 2. Détermine le cycle selon la classe
    let cyclePreferre = null
    if (classe) {
      if (['6ème','5ème','4ème','3ème (BEPC)'].includes(classe)) cyclePreferre = 'BEPC'
      else if (['Seconde','Première','Terminale'].includes(classe)) cyclePreferre = 'BAC'
      else cyclePreferre = 'BTS'
    }

    // 3. Documents déjà vus
    const { rows: dejaSeen } = await db.query(
      'SELECT DISTINCT document_id FROM user_actions WHERE user_id = $1', [userId]
    )
    const dejaSeenIds = dejaSeen.map(r => r.document_id)
    const excludeClause = dejaSeenIds.length > 0 && exclureDejaVus
      ? `AND d.id NOT IN (${dejaSeenIds.join(',')})` : ''

    // 4. Analyse les préférences comportementales
    const { rows: preferences } = await db.query(
      `SELECT d.matiere, d.cycle, d.type_document,
              SUM(CASE ua.action
                WHEN 'vue' THEN 1 WHEN 'lecture' THEN 3
                WHEN 'telechargement' THEN 5 WHEN 'commentaire' THEN 7
                WHEN 'favori' THEN 10 ELSE 1 END) as score_total
       FROM user_actions ua
       JOIN documents d ON ua.document_id = d.id
       WHERE ua.user_id = $1
       GROUP BY d.matiere, d.cycle, d.type_document
       ORDER BY score_total DESC LIMIT 5`,
      [userId]
    )

    const matieresPreferees = [...new Set(preferences.map(p => p.matiere))].slice(0, 3)
    const cyclesPreferres = [...new Set(preferences.map(p => p.cycle))].slice(0, 2)
    if (cyclePreferre && !cyclesPreferres.includes(cyclePreferre)) {
      cyclesPreferres.unshift(cyclePreferre)
    }

    // 5. Score composite intelligent
    const { rows: recommandations } = await db.query(
      `SELECT d.*,
        COALESCE(rs.score, 0) * 2

        -- Bonus filière (profil utilisateur) : le plus fort signal
        + CASE WHEN $2 IS NOT NULL AND d.serie_filiere ILIKE $2 THEN 25 ELSE 0 END
        -- Bonus cycle selon classe
        + CASE WHEN $3 IS NOT NULL AND d.cycle = $3 THEN 20 ELSE 0 END

        -- Bonus matières préférées (comportement)
        + CASE WHEN d.matiere = ANY($4::text[]) THEN 15 ELSE 0 END

        -- Bonus cycles préférés (comportement)
        + CASE WHEN d.cycle = ANY($5::text[]) THEN 10 ELSE 0 END

        -- Popularité (max 20 points)
        + LEAST(d.nb_telechargements::float / 5, 20)

        -- Fraîcheur
        + CASE WHEN d.date_upload > NOW() - INTERVAL '7 days' THEN 8 ELSE 0 END
        + CASE WHEN d.date_upload > NOW() - INTERVAL '30 days' THEN 4 ELSE 0 END

        -- Léger malus si déjà vu (pour varier)
        - CASE WHEN ua_seen.document_id IS NOT NULL THEN 3 ELSE 0 END

        AS score_final
       FROM documents d
       LEFT JOIN recommendation_scores rs
         ON rs.document_id = d.id AND rs.user_id = $1
       LEFT JOIN LATERAL (
         SELECT document_id FROM user_actions
         WHERE user_id = $1 AND document_id = d.id LIMIT 1
       ) ua_seen ON TRUE
       WHERE d.actif = 1 ${excludeClause}
       ORDER BY score_final DESC
       LIMIT $6`,
      [
        userId,
        filiere ? `%${filiere}%` : null,
        cyclePreferre,
        matieresPreferees.length > 0 ? matieresPreferees : [''],
        cyclesPreferres.length > 0 ? cyclesPreferres : [''],
        limite
      ]
    )

    if (recommandations.length === 0) return await getFallback(userId, limite)
    return recommandations

  } catch (err) {
    console.error('Erreur getRecommandations:', err.message)
    return await getFallback(userId, limite)
  }
}