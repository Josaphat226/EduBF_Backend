const axios = require('axios')

// Vérifie le jeton Cloudflare Turnstile envoyé par le formulaire
// d'inscription, pour confirmer qu'il s'agit d'un humain et non d'un script.
async function verifierTurnstile(token, ip) {
  if (!token) return false
  try {
    const { data } = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip || '',
      })
    )
    return data.success === true
  } catch (err) {
    console.error('Erreur vérification Turnstile:', err.message)
    return false
  }
}

module.exports = { verifierTurnstile }