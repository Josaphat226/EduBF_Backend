// Usage : node remplacer-proteges.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { PDFDocument } = require('pdf-lib')
const supabase = require('./database/supabase')

async function main() {
  const manifeste = JSON.parse(fs.readFileSync(path.join(__dirname, 'pdf-a-reparer', 'manifeste.json'), 'utf8'))
  for (const [id, info] of Object.entries(manifeste)) {
    const fichier = path.join(__dirname, 'pdf-repares', `${id}.pdf`)
    if (!fs.existsSync(fichier)) { console.log(id, 'ignoré : pas de version réparée'); continue }
    const octets = fs.readFileSync(fichier)
    try { await PDFDocument.load(octets) } catch { console.log(id, 'ÉCHEC : encore illisible'); continue }
    const { error } = await supabase.storage.from('documents').upload(info.chemin, octets, { contentType: 'application/pdf', upsert: true })
    console.log(id, error ? 'ERREUR upload : ' + error.message : 'remplacé ✓')
  }
}
main().catch(e => { console.error(e); process.exit(1) })