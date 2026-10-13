require('./setup')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const app = require('../server')
const { pool, creerUtilisateur, nettoyer, fermer } = require('./helpers')

const TITRE = 'Épreuve de Mathématiques TEST-EDUBF'
const FICHIER = 'secret/fichier-test-edubf.pdf'
let docId, utilisateur

async function nettoyerDocuments() {
  await pool.query(`DELETE FROM documents WHERE titre LIKE '%TEST-EDUBF%'`)
}

before(async () => {
  await nettoyer()
  await nettoyerDocuments()
  const { rows } = await pool.query(
    `INSERT INTO documents (titre, fichier_url) VALUES ($1, $2) RETURNING id`, [TITRE, FICHIER])
  docId = rows[0].id
  utilisateur = await creerUtilisateur('origine')
})

after(async () => {
  await nettoyerDocuments()
  await nettoyer()
  await fermer()
})

test('Le détail d un document ne révèle ni fichier_url, ni le chemin du fichier, ni admin_id', async () => {
  const res = await request(app).get(`/api/documents/${docId}`)
  assert.equal(res.status, 200)
  const texte = JSON.stringify(res.body)
  assert.ok(texte.includes('TEST-EDUBF'))
  assert.ok(!texte.includes('fichier_url'))
  assert.ok(!texte.includes(FICHIER))
  assert.ok(!texte.includes('admin_id'))
})

test('Un document inexistant renvoie 404', async () => {
  const res = await request(app).get('/api/documents/999999999')
  assert.equal(res.status, 404)
})

test('Télécharger ou lire sans être connecté est refusé', async () => {
  const dl = await request(app).get(`/api/documents/${docId}/telecharger`)
  const lire = await request(app).get(`/api/documents/${docId}/lire`)
  assert.equal(dl.status, 401)
  assert.equal(lire.status, 401)
})

test('La recherche trouve le document sans accents', async () => {
  const res = await request(app).get('/api/documents').query({ recherche: 'epreuve mathematiques' })
  assert.equal(res.status, 200)
  assert.ok(JSON.stringify(res.body).includes('TEST-EDUBF'))
})

test('Une requête POST venant d une origine inconnue est refusée et ne crée pas de session', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', 'https://site-pirate.example')
    .send({ email: utilisateur.email, mot_de_passe: utilisateur.mot_de_passe })
  assert.ok([403, 500].includes(res.status), `statut reçu : ${res.status}`)
  assert.ok(!res.headers['set-cookie'], 'aucun cookie de session ne doit être créé')
})

test('Une requête POST venant de l origine du frontend est acceptée', async () => {
  const origine = (process.env.FRONTEND_URLS || 'http://localhost:3001').split(',')[0].trim()
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', origine)
    .send({ email: utilisateur.email, mot_de_passe: utilisateur.mot_de_passe })
  assert.equal(res.status, 200)
})