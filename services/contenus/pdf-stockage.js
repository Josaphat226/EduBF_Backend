// Stockage des PDF des exercices : Cloudflare R2 si les variables R2_* sont renseignées,
// sinon Supabase (bucket « contenus-pdf »). Les anciens fichiers Supabase restent supprimables.
const supabase = require('../../database/supabase')

const BUCKET_PDF = 'contenus-pdf'

const r2Actif = () => !!(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET && process.env.R2_PUBLIC_URL
)
const urlPubliqueR2 = () => String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '')

let clientR2 = null
function r2() {
  if (clientR2) return clientR2
  const { S3Client } = require('@aws-sdk/client-s3')
  clientR2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    // R2 n'accepte pas les sommes de contrôle automatiques des versions récentes du SDK
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return clientR2
}

let bucketSupabasePret = false

// Envoie un PDF et renvoie son adresse publique.
// `nomFichier` : nom proposé au téléchargement (ex. EduBF-K7M2QX-corrige.pdf).
async function envoyerPdf(chemin, buffer, nomFichier) {
  if (r2Actif()) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3')
    await r2().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: chemin,
      Body: buffer,
      ContentType: 'application/pdf',
      ContentDisposition: `attachment; filename="${nomFichier}"`,
      CacheControl: 'public, max-age=31536000, immutable',
    }))
    return `${urlPubliqueR2()}/${chemin}`
  }
  if (!bucketSupabasePret) {
    await supabase.storage.createBucket(BUCKET_PDF, { public: true }).catch(() => {})
    bucketSupabasePret = true
  }
  const { error } = await supabase.storage.from(BUCKET_PDF).upload(chemin, buffer, { contentType: 'application/pdf', upsert: false })
  if (error) throw new Error('Envoi vers le stockage : ' + error.message)
  return supabase.storage.from(BUCKET_PDF).getPublicUrl(chemin).data.publicUrl
}

function cheminSupabase(url) {
  const m = String(url || '').match(/\/contenus-pdf\/([^?#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

// Ne lève jamais d'erreur : un nettoyage raté ne doit pas bloquer l'action de l'administrateur.
async function supprimerPdf(urls) {
  const liste = (urls || []).filter(Boolean)
  if (!liste.length) return
  const base = urlPubliqueR2()
  const cleR2 = []
  const cheminsSupabase = []
  for (const u of liste) {
    if (base && String(u).startsWith(base + '/')) cleR2.push(decodeURIComponent(String(u).slice(base.length + 1).split(/[?#]/)[0]))
    else { const c = cheminSupabase(u); if (c) cheminsSupabase.push(c) }
  }
  if (cleR2.length && r2Actif()) {
    try {
      const { DeleteObjectsCommand } = require('@aws-sdk/client-s3')
      await r2().send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: cleR2.map((Key) => ({ Key })) } }))
    } catch (e) { console.error('Nettoyage PDF (R2) :', e.message) }
  }
  if (cheminsSupabase.length) {
    try {
      const { error } = await supabase.storage.from(BUCKET_PDF).remove(cheminsSupabase)
      if (error) console.error('Nettoyage PDF (Supabase) :', error.message)
    } catch (e) { console.error('Nettoyage PDF (Supabase) :', e.message) }
  }
}

module.exports = { BUCKET_PDF, envoyerPdf, supprimerPdf }