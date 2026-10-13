const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const racine = path.join(__dirname, '..')
const fichierTest = path.join(racine, '.env.test')
const fichierProd = path.join(racine, '.env')

if (!fs.existsSync(fichierTest)) {
  throw new Error('.env.test introuvable : tests annulés.')
}

const test = dotenv.parse(fs.readFileSync(fichierTest))
const prod = fs.existsSync(fichierProd) ? dotenv.parse(fs.readFileSync(fichierProd)) : {}

function hote(u) {
  try { return new URL(u).host } catch { return null }
}

if (!test.DATABASE_URL) {
  throw new Error('DATABASE_URL manquant dans .env.test : tests annulés.')
}
if (hote(test.DATABASE_URL) === hote(prod.DATABASE_URL)) {
  throw new Error('La base de test est la même que la production : tests annulés.')
}
if (prod.SUPABASE_URL && test.SUPABASE_URL === prod.SUPABASE_URL) {
  throw new Error('SUPABASE_URL de test identique à la production : tests annulés.')
}

Object.assign(process.env, test)
process.env.NODE_ENV = 'test'