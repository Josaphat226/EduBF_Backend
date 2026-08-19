/**
 * EXECUTE UN FICHIER DE MIGRATION SQL
 *
 * Usage : node run-migration.js nom-du-fichier.sql
 * Le fichier doit se trouver dans database/migrations/
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const db = require('./database/database')

async function main() {
  const nomFichier = process.argv[2]

  if (!nomFichier) {
    console.error('Usage : node run-migration.js nom-du-fichier.sql')
    process.exit(1)
  }

  const cheminFichier = path.join(__dirname, 'database', 'migrations', nomFichier)

  if (!fs.existsSync(cheminFichier)) {
    console.error(`Fichier introuvable : ${cheminFichier}`)
    process.exit(1)
  }

  const sql = fs.readFileSync(cheminFichier, 'utf-8')

  console.log(`Exécution de ${nomFichier}...\n`)

  try {
    await db.query(sql)
    console.log(`✓ ${nomFichier} exécuté avec succès.`)
  } catch (err) {
    console.error(`✗ Erreur lors de l'exécution de ${nomFichier} :`)
    console.error(err.message)
    process.exit(1)
  } finally {
    await db.end()
  }
}

main()