const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// Sans ce gestionnaire, une erreur sur une connexion inactive du pool
// (coupure reseau, timeout du pooler Supabase...) fait planter TOUT le
// processus Node d'un coup — silencieusement, sans message clair.
pool.on('error', (err) => {
  console.error('Erreur inattendue sur une connexion inactive du pool PostgreSQL:', err)
})

module.exports = pool