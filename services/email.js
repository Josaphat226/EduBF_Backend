const { Resend } = require('resend')

const resend = new Resend(process.env.RESEND_API_KEY)

// Envoie l'email de bienvenue à un nouvel utilisateur, quelle que soit la
// méthode d'inscription (email/mot de passe ou Google). Ne fait jamais
// planter l'inscription si l'envoi échoue : l'erreur est juste loguée.
async function envoyerEmailBienvenue(email, nomComplet) {
  try {
    const lienFrontend = (process.env.FRONTEND_URLS || 'http://localhost:3001').split(',')[0].trim()

    await resend.emails.send({
      from: 'EduBF <noreply@edubf.net>',
      to: email,
      subject: 'Bienvenue sur EduBF 🎓',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem;">
          <h2 style="color:#0F172A;">Bienvenue sur EduBF, ${nomComplet} !</h2>
          <p>Ton compte a bien été créé. Tu peux dès maintenant consulter, lire et télécharger les documents disponibles sur la plateforme.</p>
          <p style="margin-top:1.5rem;">
            <a href="${lienFrontend}" style="background:#F59E0B;color:#0F172A;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:600;">
              Accéder à EduBF
            </a>
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('Erreur envoi email de bienvenue:', err.message)
  }
}

module.exports = { envoyerEmailBienvenue }