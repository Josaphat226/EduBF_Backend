// Usage : node setup-test-db.js --check   (affiche seulement les adresses, ne modifie rien)
//         node setup-test-db.js           (crée les tables dans la base de TEST)
const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const { Client } = require('pg')

function lireUrl(fichier) {
  const chemin = path.join(__dirname, fichier)
  if (!fs.existsSync(chemin)) return null
  const vars = dotenv.parse(fs.readFileSync(chemin))
  return vars.DATABASE_URL || null
}

const urlTest = lireUrl('.env.test')
const urlProd = lireUrl('.env')

function hote(u) { try { return new URL(u).host } catch { return null } }
const hoteTest = hote(urlTest)
const hoteProd = hote(urlProd)

console.log('Base de TEST       :', hoteTest || '(introuvable)')
console.log('Base de PRODUCTION :', hoteProd || '(introuvable)')

if (!hoteTest) { console.error('\nARRÊT : .env.test absent ou sans DATABASE_URL.'); process.exit(1) }
if (hoteTest === hoteProd) { console.error('\nARRÊT : la base de test est la MÊME que la production. Rien n\'a été exécuté.'); process.exit(1) }
if (urlTest === urlProd) { console.error('\nARRÊT : les deux liens sont identiques.'); process.exit(1) }
if (process.argv.includes('--check')) { console.log('\nVérification OK : les deux bases sont différentes.'); process.exit(0) }

async function main() {
  const client = new Client({ connectionString: urlTest, ssl: { rejectUnauthorized: false } })
  await client.connect()

  // La base de test doit être VIDE : on refuse si la table des documents existe déjà
  const { rows } = await client.query("SELECT to_regclass('public.documents') AS t")
  if (rows[0].t) { console.error('\nARRÊT : la base de test contient déjà des tables. Rien n\'a été exécuté.'); await client.end(); process.exit(1) }

  const dossier = path.join(__dirname, 'database', 'migrations')
  const fichiers = fs.readdirSync(dossier).filter(f => /^\d+_.*\.sql$/.test(f)).sort()

  for (const f of fichiers) {
    process.stdout.write(`${f} ... `)
    try {
      await client.query(fs.readFileSync(path.join(dossier, f), 'utf8'))
      console.log('ok')
    } catch (err) {
      console.log('ERREUR :', err.message)
      await client.end()
      process.exit(1)
    }
  }
  await client.end()
  console.log('\nBase de test prête.')
}
main().catch(e => { console.error(e); process.exit(1) })