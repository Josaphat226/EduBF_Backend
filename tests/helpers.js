require('./setup')
const bcrypt = require('bcrypt')
const { Pool } = require('pg')

const MOT_DE_PASSE = 'Test1234!'
const DOMAINE = '@test.edubf.invalid'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
})

async function creerUtilisateur(prefixe = 'user') {
  const email = `${prefixe}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${DOMAINE}`.toLowerCase()
  const hash = await bcrypt.hash(MOT_DE_PASSE, 4)
  const { rows } = await pool.query(
    `INSERT INTO users (nom_complet, email, mot_de_passe, statut, email_verifie)
     VALUES ($1, $2, $3, 'actif', 1) RETURNING id`,
    ['Utilisateur Test', email, hash]
  )
  return { id: rows[0].id, email, mot_de_passe: MOT_DE_PASSE }
}




async function creerAdmin(prefixe = 'admin') {
  const email = `${prefixe}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${DOMAINE}`.toLowerCase()
  const hash = await bcrypt.hash(MOT_DE_PASSE, 4)
  const { rows } = await pool.query(
    `INSERT INTO admins (nom, email, mot_de_passe) VALUES ($1, $2, $3) RETURNING id`,
    ['Admin Test', email, hash]
  )
  return { id: rows[0].id, email, mot_de_passe: MOT_DE_PASSE }
}


async function nettoyer() {
  const ids = `SELECT id FROM users WHERE email LIKE '%${DOMAINE}'`
  const requetes = [
    `DELETE FROM concours.reponses_session WHERE session_id IN (SELECT id FROM concours.sessions WHERE user_id IN (${ids}))`,
    `DELETE FROM concours.session_questions WHERE session_id IN (SELECT id FROM concours.sessions WHERE user_id IN (${ids}))`,
    `DELETE FROM concours.sessions WHERE user_id IN (${ids})`,
    `DELETE FROM commentaires WHERE user_id IN (${ids})`,
    `DELETE FROM favoris WHERE user_id IN (${ids})`,
    `DELETE FROM recommendation_scores WHERE user_id IN (${ids})`,
    `DELETE FROM reset_tokens WHERE user_id IN (${ids})`,
    `DELETE FROM user_actions WHERE user_id IN (${ids})`
  ]
  for (const sql of requetes) {
    try { await pool.query(sql) } catch (e) { console.log('Nettoyage ignoré :', e.message) }
  }
    await pool.query(`DELETE FROM users WHERE email LIKE '%${DOMAINE}'`)
  try {
    await pool.query(`DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM admins WHERE email LIKE '%${DOMAINE}')`)
  } catch (e) { console.log('Nettoyage ignoré :', e.message) }
  await pool.query(`DELETE FROM admins WHERE email LIKE '%${DOMAINE}'`)
  try {
    await pool.query(`DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM admins WHERE email LIKE '%${DOMAINE}')`)
  } catch (e) { console.log('Nettoyage ignoré :', e.message) }
  await pool.query(`DELETE FROM admins WHERE email LIKE '%${DOMAINE}'`)
}

async function fermer() {
  await pool.end()
}

module.exports = { pool, creerUtilisateur, creerAdmin, nettoyer, fermer, MOT_DE_PASSE }