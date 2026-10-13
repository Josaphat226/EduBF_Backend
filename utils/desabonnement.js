const crypto = require('crypto')

function secret() {
  return process.env.UNSUB_SECRET || process.env.SESSION_SECRET
}

function jeton(email) {
  return crypto.createHmac('sha256', secret()).update(email.toLowerCase()).digest('hex')
}

function jetonValide(email, recu) {
  const attendu = Buffer.from(jeton(email))
  const donne = Buffer.from(String(recu))
  return attendu.length === donne.length && crypto.timingSafeEqual(attendu, donne)
}

function lienDesabonnement(email) {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:3000'
  return `${base}/api/desabonnement?email=${encodeURIComponent(email.toLowerCase())}&token=${jeton(email)}`
}

module.exports = { jetonValide, lienDesabonnement }