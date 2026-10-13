const db = require('../database/database')
const { Resend } = require('resend')
const { lienDesabonnement } = require('../utils/desabonnement')

const FROM = 'EduBF <annonces@edubf.net>'
const LIMITE_JOUR = parseInt(process.env.EMAIL_LIMITE_JOUR || '80', 10)
const TAILLE_LOT = 50
const INTERVALLE_MS = 5 * 60 * 1000

let client = null
function resend() {
  if (!client) client = new Resend(process.env.RESEND_API_KEY)
  return client
}

const pause = (ms) => new Promise(r => setTimeout(r, ms))

function echapper(texte) {
  return String(texte || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function urlSure(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : null
}

function messageEnHtml(message) {
  return String(message).split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 16px;line-height:1.6">${echapper(p.trim()).replace(/\n/g, '<br>')}</p>`
  ).join('')
}

function construireEmail(campagne, email) {
  const lien = lienDesabonnement(email)
  const lienBouton = urlSure(campagne.bouton_lien)
  const bouton = (campagne.bouton_texte && lienBouton)
    ? `<p style="margin:24px 0"><a href="${echapper(lienBouton)}" style="background:#e8730c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${echapper(campagne.bouton_texte)}</a></p>`
    : ''
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#1f2937"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:12px;padding:28px"><h2 style="margin:0 0 20px;color:#111">${echapper(campagne.sujet)}</h2>${messageEnHtml(campagne.message)}${bouton}</div><p style="font-size:12px;color:#6b7280;text-align:center;margin-top:16px">Tu reçois cet e-mail car tu es inscrit(e) à EduBF.<br><a href="${echapper(lien)}" style="color:#6b7280">Se désabonner</a></p></div></body></html>`
  const text = `${campagne.message}\n\n${lienBouton ? campagne.bouton_texte + ' : ' + lienBouton + '\n\n' : ''}Se désabonner : ${lien}`
  return {
    from: FROM,
    to: [email],
    subject: campagne.sujet,
    html,
    text,
    headers: { 'List-Unsubscribe': `<${lien}>` }
  }
}

const SOURCES = {
  utilisateurs: `SELECT email FROM users WHERE statut = 'actif' AND email_verifie = 1`,
  newsletter: `SELECT email FROM newsletter_abonnes`
}

function sourceSql(cible) {
  if (cible === 'tous') return `${SOURCES.utilisateurs} UNION ${SOURCES.newsletter}`
  return SOURCES[cible] || SOURCES.utilisateurs
}

// $1 = identifiant de campagne (texte)
function requeteRestants(cible) {
  return `SELECT DISTINCT lower(trim(email)) AS email FROM (${sourceSql(cible)}) t
    WHERE email IS NOT NULL AND trim(email) <> ''
      AND lower(email) NOT LIKE '%@test.edubf.invalid'
      AND lower(trim(email)) NOT IN (SELECT email FROM email_desabonnes)
      AND lower(trim(email)) NOT IN (SELECT email FROM email_envois WHERE campagne = $1)`
}

async function compterDestinataires(cible, campagneId = '0') {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM (${requeteRestants(cible)}) r`, [String(campagneId)])
  return rows[0].n
}

async function envoyesAujourdhui() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM email_envois WHERE date_envoi >= date_trunc('day', now())`)
  return rows[0].n
}

async function envoyerTest(campagne, email) {
  const { error } = await resend().emails.send(construireEmail(campagne, email))
  if (error) throw new Error(error.message || 'Échec de l\'envoi du test.')
}

async function traiterUneCampagne(c) {
  while (true) {
    const { rows: etat } = await db.query('SELECT statut FROM campagnes_email WHERE id = $1', [c.id])
    if (!etat[0] || etat[0].statut !== 'en_cours') return 'arret'

    const restantQuota = LIMITE_JOUR - await envoyesAujourdhui()
    const limite = Math.max(0, Math.min(TAILLE_LOT, restantQuota))

    const { rows } = await db.query(
      `${requeteRestants(c.cible)} ORDER BY 1 LIMIT ${Math.max(limite, 1)}`, [String(c.id)])

    if (rows.length === 0) {
      await db.query(
        `UPDATE campagnes_email SET statut = 'terminee', date_fin = NOW() WHERE id = $1 AND statut = 'en_cours'`,
        [c.id])
      return 'terminee'
    }
    if (limite === 0) return 'quota'

    // On réserve d'abord les adresses : si deux serveurs tournent, personne ne reçoit deux fois.
    const { rows: reserves } = await db.query(
      `INSERT INTO email_envois (campagne, email)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING RETURNING email`,
      [String(c.id), rows.slice(0, limite).map(r => r.email)])
    if (reserves.length === 0) return 'arret'
    const adresses = reserves.map(r => r.email)

    let erreur = null
    try {
      const res = await resend().batch.send(adresses.map(e => construireEmail(c, e)))
      erreur = res.error
    } catch (e) {
      erreur = e
    }

    if (erreur) {
      await db.query('DELETE FROM email_envois WHERE campagne = $1 AND email = ANY($2::text[])',
        [String(c.id), adresses])
      const message = String(erreur.message || JSON.stringify(erreur)).slice(0, 500)
      await db.query('UPDATE campagnes_email SET derniere_erreur = $2 WHERE id = $1', [c.id, message])
      console.error('Campagne', c.id, ': échec d\'envoi :', message)
      return 'erreur'
    }

    await db.query(
      'UPDATE campagnes_email SET nb_envoyes = nb_envoyes + $2, derniere_erreur = NULL WHERE id = $1',
      [c.id, adresses.length])
    await pause(1000)
  }
}

let enCours = false

async function traiterCampagnes() {
  if (enCours) return
  enCours = true
  try {
    const { rows } = await db.query(`SELECT * FROM campagnes_email WHERE statut = 'en_cours' ORDER BY id`)
    for (const c of rows) {
      const resultat = await traiterUneCampagne(c)
      if (resultat === 'quota' || resultat === 'erreur') break
    }
  } catch (err) {
    console.error('Planificateur e-mails :', err.message)
  } finally {
    enCours = false
  }
}

function demarrerPlanificateur() {
  setTimeout(traiterCampagnes, 20 * 1000).unref()
  setInterval(traiterCampagnes, INTERVALLE_MS).unref()
  console.log(`Planificateur d'e-mails actif (limite ${LIMITE_JOUR} par jour)`)
}

module.exports = {
  LIMITE_JOUR,
  construireEmail,
  compterDestinataires,
  envoyesAujourdhui,
  envoyerTest,
  traiterCampagnes,
  demarrerPlanificateur
}