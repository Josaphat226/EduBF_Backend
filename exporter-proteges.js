// Usage : node exporter-proteges.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const db = require('./database/database')
const supabase = require('./database/supabase')

const IDS = [98, 100, 131, 136, 139, 160, 166, 349, 377, 378, 379, 380, 381, 382, 449, 451, 457, 459, 460, 461, 462, 463, 464, 465, 466, 467, 468]
const DOSSIER = path.join(__dirname, 'pdf-a-reparer')

function chemin(u) {
  if (!u.startsWith('http')) return u
  const idx = u.indexOf('/documents/')
  return idx === -1 ? null : u.substring(idx + '/documents/'.length)
}

async function main() {
  fs.mkdirSync(DOSSIER, { recursive: true })
  const { rows } = await db.query('SELECT id, titre, fichier_url FROM documents WHERE id = ANY($1) ORDER BY id', [IDS])
  const manifeste = {}
  for (const doc of rows) {
    const nom = chemin(doc.fichier_url)
    const { data, error } = await supabase.storage.from('documents').download(nom)
    if (error) { console.log(doc.id, 'ERREUR', error.message); continue }
    fs.writeFileSync(path.join(DOSSIER, `${doc.id}.pdf`), Buffer.from(await data.arrayBuffer()))
    manifeste[doc.id] = { titre: doc.titre, chemin: nom }
    console.log(doc.id, 'exporté')
  }
  fs.writeFileSync(path.join(DOSSIER, 'manifeste.json'), JSON.stringify(manifeste, null, 2))
  await db.end()
}
main().catch(e => { console.error(e); process.exit(1) })