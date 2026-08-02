/**
 * SCRIPT DE DONNÉES DE TEST — EduBF
 * Lance avec : node database/seed.js
 */

require('dotenv').config()
const { Pool } = require('pg')
const bcrypt = require('bcrypt')

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// ===== DONNÉES DE TEST =====

const UTILISATEURS = [
  { nom: 'Konaté Seydou',    email: 'konate@test.bf',   classe: 'Terminale',      filiere: 'BAC D' },
  { nom: 'Traoré Aminata',   email: 'traore@test.bf',   classe: 'Terminale',      filiere: 'BAC A' },
  { nom: 'Ouédraogo Moussa', email: 'ouedraogo@test.bf',classe: '3ème (BEPC)',    filiere: null },
  { nom: 'Sawadogo Fatima',  email: 'sawadogo@test.bf', classe: '1ère année',     filiere: 'BTS Informatique de Gestion' },
  { nom: 'Compaoré Jules',   email: 'compaore@test.bf', classe: 'Première',       filiere: 'BAC C' },
  { nom: 'Zongo Marie',      email: 'zongo@test.bf',    classe: '2ème année',     filiere: 'BTS Comptabilité et Gestion' },
  { nom: 'Ilboudo David',    email: 'ilboudo@test.bf',  classe: '3ème (BEPC)',    filiere: null },
  { nom: 'Kabré Rasmata',    email: 'kabre@test.bf',    classe: 'Terminale',      filiere: 'BAC B' },
  { nom: 'Diallo Ibrahim',     email: 'diallo@test.bf',    classe: 'Terminale',   filiere: 'BAC D' },
{ nom: 'Bambara Awa',        email: 'bambara@test.bf',   classe: 'Première',    filiere: 'BAC A' },
{ nom: 'Kinda Serge',        email: 'kinda@test.bf',     classe: '2ème année',  filiere: 'BTS Informatique de Gestion' },
{ nom: 'Nikiema Salif',      email: 'nikiema@test.bf',   classe: '3ème (BEPC)', filiere: null },
{ nom: 'Yameogo Clarisse',   email: 'yameogo@test.bf',   classe: 'Terminale',   filiere: 'BAC B' },
{ nom: 'Sanou Patrice',      email: 'sanou@test.bf',     classe: 'Première',    filiere: 'BAC C' },
{ nom: 'Tapsoba Adama',      email: 'tapsoba@test.bf',   classe: '1ère année',  filiere: 'BTS Comptabilité et Gestion' },
{ nom: 'Belem Nadia',        email: 'belem@test.bf',     classe: 'Terminale',   filiere: 'BAC A' },
{ nom: 'Ouattara Abdoul',     email: 'ouattara@test.bf',    classe: 'Terminale',   filiere: 'BAC D' },
{ nom: 'Sankara Julie',       email: 'sankara@test.bf',     classe: 'Première',    filiere: 'BAC A' },
{ nom: 'Zida Roland',         email: 'zida@test.bf',        classe: '3ème (BEPC)', filiere: null },
{ nom: 'Toe Mariam',          email: 'toe@test.bf',         classe: '2ème année',  filiere: 'BTS Comptabilité et Gestion' },
{ nom: 'Ganou Issa',          email: 'ganou@test.bf',       classe: 'Terminale',   filiere: 'BAC C' },
{ nom: 'Kouanda Estelle',     email: 'kouanda@test.bf',     classe: 'Première',    filiere: 'BAC B' },
{ nom: 'Savadogo Idrissa',    email: 'savadogo@test.bf',    classe: '1ère année',  filiere: 'BTS Informatique de Gestion' },
{ nom: 'Barro Karim',         email: 'barro@test.bf',       classe: 'Terminale',   filiere: 'BAC A' },
{ nom: 'Somé Nadège',         email: 'some@test.bf',        classe: '3ème (BEPC)', filiere: null },
{ nom: 'Kaboré Lionel',       email: 'kabore2@test.bf',     classe: 'Terminale',   filiere: 'BAC D' },
{ nom: 'Diarra Fatou',        email: 'diarra@test.bf',      classe: 'Première',    filiere: 'BAC C' },
{ nom: 'Bazié Arnaud',        email: 'bazie@test.bf',       classe: '2ème année',  filiere: 'BTS Informatique de Gestion' }
]

const DOCUMENTS = [
  // BEPC
  { titre: 'Sujet BEPC Mathématiques 2023', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Mathématiques', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Sujet BEPC Français 2023', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Français', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Corrigé BEPC SVT 2022', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'SVT', type_document: 'Corrigé', annee_scolaire: '2022-2023' },
  { titre: 'Sujet BEPC Histoire-Géographie 2023', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Histoire-Géographie', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Cours Mathématiques 3ème — Fonctions', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Mathématiques', type_document: 'Cours', annee_scolaire: null },
  { titre: 'Corrigé BEPC Mathématiques 2023', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Mathématiques', type_document: 'Corrigé', annee_scolaire: '2023-2024' },
{ titre: 'Sujet BEPC Anglais 2023', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Anglais', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  // BAC D
  { titre: 'Sujet BAC D Mathématiques 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Mathématiques', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Sujet BAC D SVT 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'SVT', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Corrigé BAC D Physique-Chimie 2022', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Physique-Chimie', type_document: 'Corrigé', annee_scolaire: '2022-2023' },
  { titre: 'Cours SVT Terminale D — Génétique', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'SVT', type_document: 'Cours', annee_scolaire: null },
  { titre: 'Examen blanc BAC D 2024', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Mathématiques', type_document: 'Examen blanc', annee_scolaire: '2024-2025' },
  // BAC A
  { titre: 'Sujet BAC A Français 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC A', matiere: 'Français', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Sujet BAC A Philosophie 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC A', matiere: 'Philosophie', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Corrigé BAC A Histoire-Géo 2022', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC A', matiere: 'Histoire-Géographie', type_document: 'Corrigé', annee_scolaire: '2022-2023' },
  // BAC C
  { titre: 'Sujet BAC C Mathématiques 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC C', matiere: 'Mathématiques', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Sujet BAC C Physique-Chimie 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC C', matiere: 'Physique-Chimie', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  // BAC B
  { titre: 'Sujet BAC B Économie 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC B', matiere: 'Économie', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Cours Comptabilité Terminale B', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC B', matiere: 'Comptabilité', type_document: 'Cours', annee_scolaire: null },
  // BTS
  { titre: 'TD Programmation Web BTS Info', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Informatique de Gestion', matiere: 'Informatique', type_document: 'TD / TP', annee_scolaire: null },
  { titre: 'Sujet BTS Informatique 2023', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Informatique de Gestion', matiere: 'Informatique', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'Cours Base de données BTS Info', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Informatique de Gestion', matiere: 'Informatique', type_document: 'Cours', annee_scolaire: null },
  { titre: 'Sujet BTS Comptabilité 2023', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Comptabilité et Gestion', matiere: 'Comptabilité', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },
  { titre: 'TD Comptabilité analytique BTS', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Comptabilité et Gestion', matiere: 'Comptabilité', type_document: 'TD / TP', annee_scolaire: null },
  // BAC D
{ titre: 'Corrigé BAC D Mathématiques 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Mathématiques', type_document: 'Corrigé', annee_scolaire: '2023-2024' },
{ titre: 'TD Physique Terminale D', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Physique-Chimie', type_document: 'TD / TP', annee_scolaire: null },

// BAC A
{ titre: 'Cours Philosophie Terminale A', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC A', matiere: 'Philosophie', type_document: 'Cours', annee_scolaire: null },

// BAC C
{ titre: 'Corrigé BAC C Physique 2022', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC C', matiere: 'Physique-Chimie', type_document: 'Corrigé', annee_scolaire: '2022-2023' },

// BAC B
{ titre: 'Sujet BAC B Mathématiques 2023', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC B', matiere: 'Mathématiques', type_document: 'Sujet officiel', annee_scolaire: '2023-2024' },

// BTS Info
{ titre: 'Examen Réseau BTS Info 2023', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Informatique de Gestion', matiere: 'Informatique', type_document: 'Examen', annee_scolaire: '2023-2024' },

// BTS Compta
{ titre: 'Cours Fiscalité BTS Comptabilité', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Comptabilité et Gestion', matiere: 'Comptabilité', type_document: 'Cours', annee_scolaire: null },
// ===== BEPC =====
{ titre: 'Cours Français 3ème — Dissertation', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'Français', type_document: 'Cours', annee_scolaire: null },
{ titre: 'TD SVT 3ème — Corps humain', cycle: 'BEPC', niveau: 'Collège', serie_filiere: null, matiere: 'SVT', type_document: 'TD / TP', annee_scolaire: null },

// ===== BAC D =====
{ titre: 'Cours Physique Terminale D — Électricité', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Physique-Chimie', type_document: 'Cours', annee_scolaire: null },
{ titre: 'Sujet BAC D Chimie 2022', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'Physique-Chimie', type_document: 'Sujet officiel', annee_scolaire: '2022-2023' },
{ titre: 'Corrigé BAC D SVT 2021', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC D', matiere: 'SVT', type_document: 'Corrigé', annee_scolaire: '2021-2022' },

// ===== BAC A =====
{ titre: 'TD Français Terminale A — Commentaire', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC A', matiere: 'Français', type_document: 'TD / TP', annee_scolaire: null },
{ titre: 'Cours Histoire Terminale A — Colonisation', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC A', matiere: 'Histoire-Géographie', type_document: 'Cours', annee_scolaire: null },

// ===== BAC C =====
{ titre: 'TD Mathématiques Terminale C', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC C', matiere: 'Mathématiques', type_document: 'TD / TP', annee_scolaire: null },
{ titre: 'Corrigé BAC C Mathématiques 2022', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC C', matiere: 'Mathématiques', type_document: 'Corrigé', annee_scolaire: '2022-2023' },

// ===== BAC B =====
{ titre: 'TD Économie Terminale B — Marché', cycle: 'BAC', niveau: 'Lycée', serie_filiere: 'BAC B', matiere: 'Économie', type_document: 'TD / TP', annee_scolaire: null },

// ===== BTS INFO =====
{ titre: 'Cours Réseau BTS — TCP/IP', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Informatique de Gestion', matiere: 'Informatique', type_document: 'Cours', annee_scolaire: null },
{ titre: 'TD Base de données — SQL Avancé', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Informatique de Gestion', matiere: 'Informatique', type_document: 'TD / TP', annee_scolaire: null },

// ===== BTS COMPTA =====
{ titre: 'Cours Audit Comptable BTS', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Comptabilité et Gestion', matiere: 'Comptabilité', type_document: 'Cours', annee_scolaire: null },
{ titre: 'Examen BTS Comptabilité 2022', cycle: 'BTS', niveau: 'Supérieur', serie_filiere: 'BTS Comptabilité et Gestion', matiere: 'Comptabilité', type_document: 'Examen', annee_scolaire: '2022-2023' }
]

async function seed() {
  console.log('🌱 Démarrage du seed...\n')

  try {
    // Récupère l'admin
    const { rows: admins } = await db.query('SELECT id FROM admins LIMIT 1')
    if (admins.length === 0) {
      console.log('❌ Aucun admin trouvé. Crée d\'abord un admin.')
      process.exit(1)
    }
    const adminId = admins[0].id

    // ===== UTILISATEURS =====
    console.log('👥 Création des utilisateurs de test...')
    const hash = await bcrypt.hash('password123', 12)
    const userIds = []

    for (const u of UTILISATEURS) {
      const { rows: existing } = await db.query(
        'SELECT id FROM users WHERE email = $1', [u.email]
      )
      if (existing.length > 0) {
        console.log(`  ⚠️  ${u.email} existe déjà — ignoré`)
        userIds.push(existing[0].id)
        continue
      }

      const { rows } = await db.query(
        `INSERT INTO users (nom_complet, email, mot_de_passe, filiere_preferee, filiere, classe, email_verifie)
         VALUES ($1, $2, $3, $4, $4, $5, 1) RETURNING id`,
        [u.nom, u.email, hash, u.filiere, u.classe]
      )
      userIds.push(rows[0].id)
      console.log(`  ✅ ${u.nom} (${u.classe || 'Sans classe'}) créé`)
    }

    // ===== DOCUMENTS =====
    console.log('\n📄 Création des documents de test...')
    const docIds = []
    const fakeUrl = 'https://www.w3.org/WAI/UR/WCAG20/WCAG20-TECHS/pdf/PDF1.pdf'

    for (const d of DOCUMENTS) {
      const { rows: existing } = await db.query(
        'SELECT id FROM documents WHERE titre = $1', [d.titre]
      )
      if (existing.length > 0) {
        console.log(`  ⚠️  "${d.titre}" existe déjà — ignoré`)
        docIds.push(existing[0].id)
        continue
      }

      const nbTelechargements = Math.floor(Math.random() * 200) + 10

      const { rows } = await db.query(
        `INSERT INTO documents
          (titre, description, fichier_url, niveau, cycle, serie_filiere, matiere,
           type_document, annee_scolaire, admin_id, statut, actif, nb_telechargements)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'publie', 1, $11)
         RETURNING id`,
        [
          d.titre,
          `Document de test — ${d.matiere} — ${d.cycle}`,
          fakeUrl,
          d.niveau, d.cycle, d.serie_filiere, d.matiere,
          d.type_document, d.annee_scolaire, adminId,
          nbTelechargements
        ]
      )
      docIds.push(rows[0].id)
      console.log(`  ✅ "${d.titre}" créé (${nbTelechargements} téléch.)`)
    }

    // ===== ACTIONS SIMULÉES =====
    console.log('\n⚡ Simulation des actions utilisateurs...')

    const actions = ['vue', 'vue', 'vue', 'telechargement', 'lecture', 'favori']

    for (let u = 0; u < userIds.length; u++) {
      const userId = userIds[u]
      const userInfo = UTILISATEURS[u]

      // Chaque utilisateur interagit avec 5-10 documents
      const nbDocs = Math.floor(Math.random() * 6) + 5
      const docsChoisis = [...docIds].sort(() => Math.random() - 0.5).slice(0, nbDocs)

      for (const docId of docsChoisis) {
        const nbActions = Math.floor(Math.random() * 3) + 1
        for (let a = 0; a < nbActions; a++) {
          const action = actions[Math.floor(Math.random() * actions.length)]
          await db.query(
            'INSERT INTO user_actions (user_id, document_id, action, duree_secondes) VALUES ($1, $2, $3, $4)',
            [userId, docId, action, Math.floor(Math.random() * 300)]
          )
        }

        // Recalcule le score
        const { rows: acts } = await db.query(
          'SELECT action, duree_secondes FROM user_actions WHERE user_id = $1 AND document_id = $2',
          [userId, docId]
        )
        const POIDS = { vue: 1, lecture: 3, telechargement: 5, commentaire: 7, favori: 10 }
        let score = 0
        for (const a of acts) {
          score += (POIDS[a.action] || 1)
          if (a.duree_secondes > 30) score += 1
          if (a.duree_secondes > 120) score += 2
        }
        await db.query(
          `INSERT INTO recommendation_scores (user_id, document_id, score)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, document_id) DO UPDATE SET score = $3`,
          [userId, docId, score]
        )
      }
      console.log(`  ✅ ${userInfo.nom} — ${nbDocs} interactions simulées`)
    }

    console.log('\n✅ Seed terminé avec succès !')
    console.log('\n📋 Comptes de test créés (mot de passe : password123) :')
    UTILISATEURS.forEach(u => {
      console.log(`  - ${u.email} | ${u.classe || 'Sans classe'} | ${u.filiere || 'Sans filière'}`)
    })

  } catch (err) {
    console.error('❌ Erreur seed:', err)
  } finally {
    await db.end()
  }
}

seed()