// Usage, depuis EduBF_Backend : node lister-pdf-proteges.js
require('dotenv').config()
const { PDFDocument } = require('pdf-lib')
const db = require('./database/database')
const supabase = require('./database/supabase')

function chemin(fichierUrl) {
  if (!fichierUrl.startsWith('http')) return fichierUrl
  const marker = '/documents/'
  const idx = fichierUrl.indexOf(marker)
  return idx === -1 ? null : fichierUrl.substring(idx + marker.length)
}

async function main() {
  const { rows } = await db.query('SELECT id, titre, fichier_url FROM documents WHERE actif = 1 ORDER BY id')
  const proteges = []
  const illisibles = []

  for (const doc of rows) {
    try {
      const nom = chemin(doc.fichier_url)
      if (!nom) { illisibles.push({ id: doc.id, titre: doc.titre, raison: 'URL invalide' }); continue }
      const { data, error } = await supabase.storage.from('documents').download(nom)
      if (error) { illisibles.push({ id: doc.id, titre: doc.titre, raison: 'Introuvable : ' + error.message }); continue }
      await PDFDocument.load(Buffer.from(await data.arrayBuffer()))
    } catch (err) {
      const liste = /encrypted/i.test(err.message) ? proteges : illisibles
      liste.push({ id: doc.id, titre: doc.titre, raison: err.message.slice(0, 80) })
    }
    process.stdout.write('.')
  }

  console.log(`\n\n${rows.length} documents vérifiés.`)
  console.log(`\nPDF protégés (${proteges.length}) :`)
  console.table(proteges)
  console.log(`\nPDF illisibles ou introuvables (${illisibles.length}) :`)
  console.table(illisibles)
  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })