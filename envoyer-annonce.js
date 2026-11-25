require('dotenv').config()
const fs = require('fs')
const { Pool } = require('pg')
const { Resend } = require('resend')
const { lienDesabonnement } = require('./utils/desabonnement')

const args = process.argv.slice(2)
const val = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null }

const campagne = val('--campagne')
const sujet = val('--sujet')
const fichier = val('--fichier')
const adresseTest = val('--test')
const envoyer = args.includes('--envoyer')
const avecNewsletter = args.includes('--avec-newsletter')
const limite = parseInt(val('--limite') || '90', 10)
const FROM = 'EduBF <annonces@edubf.net>'

if (!sujet || !fichier || (!adresseTest && !campagne)) {
  console.log('Usage :')
  console.log('  Simulation : node envoyer-annonce.js --campagne NOM --sujet "..." --fichier annonces/x.html')
  console.log('  Test       : node envoyer-annonce.js --sujet "..." --fichier annonces/x.html --test toi@exemple.com')
  console.log('  Envoi réel : node envoyer-annonce.js --campagne NOM --sujet "..." --fichier annonces/x.html --envoyer [--limite 90] [--avec-newsletter]')
  process.exit(1)
}

const corps = fs.readFileSync(fichier, 'utf8')
const resend = new Resend(process.env.RESEND_API_KEY)

function construire(email) {
  const lien = lienDesabonnement(email)
  const html = corps + `<hr><p style="font-size:12px;color:#666">Tu reçois cet e-mail car tu as un compte EduBF. <a href="${lien}">Se désabonner</a></p>`
  return {
    from: FROM,
    to: [email],
    subject: sujet,
    html,
    headers: { 'List-Unsubscribe': `<${lien}>` }
  }
}

async function main() {
  if (adresseTest) {
    const { error } = await resend.emails.send(construire(adresseTest))
    if (error) { console.error('Échec :', error); process.exit(1) }
    console.log('E-mail de test envoyé à', adresseTest)
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  const sources = [`SELECT email FROM users WHERE statut = 'actif' AND email_verifie = 1`]
  if (avecNewsletter) sources.push(`SELECT email FROM newsletter_abonnes`)

  const { rows } = await pool.query(`
    SELECT DISTINCT lower(email) AS email FROM (${sources.join(' UNION ')}) t
    WHERE email IS NOT NULL
      AND lower(email) NOT LIKE '%@test.edubf.invalid'
      AND lower(email) NOT IN (SELECT email FROM email_desabonnes)
      AND lower(email) NOT IN (SELECT email FROM email_envois WHERE campagne = $1)
    ORDER BY 1
  `, [campagne])

  const aEnvoyer = rows.slice(0, limite)
  console.log(`Destinataires restants : ${rows.length} | cet envoi : ${aEnvoyer.length} (limite ${limite})`)

  if (!envoyer) {
    console.log('SIMULATION : rien n\'a été envoyé. Ajoute --envoyer pour envoyer réellement.')
    await pool.end()
    return
  }

  for (let i = 0; i < aEnvoyer.length; i += 100) {
    const lot = aEnvoyer.slice(i, i + 100)
    const { error } = await resend.batch.send(lot.map(r => construire(r.email)))
    if (error) { console.error('Échec du lot, arrêt :', error); break }
    for (const r of lot) {
      await pool.query('INSERT INTO email_envois (campagne, email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [campagne, r.email])
    }
    console.log(`Lot envoyé : ${lot.length} e-mails`)
  }
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })