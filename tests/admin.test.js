require('./setup')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const app = require('../server')
const { creerUtilisateur, creerAdmin, nettoyer, fermer } = require('./helpers')

let admin, utilisateur

const ROUTES_ADMIN = [
  '/api/admin/dashboard',
  '/api/admin/documents',
  '/api/admin/utilisateurs',
  '/api/admin/commentaires',
  '/api/admin/journal',
  '/api/admin/concours/questions',
  '/api/admin/concours/series',
  '/api/admin/referentiels/matieres'
]

before(async () => {
  await nettoyer()
  admin = await creerAdmin('admin')
  utilisateur = await creerUtilisateur('simple')
})

after(async () => {
  await nettoyer()
  await fermer()
})

test('Sans connexion : toutes les routes admin sont refusées', async () => {
  for (const chemin of ROUTES_ADMIN) {
    const res = await request(app).get(chemin)
    assert.ok([401, 403].includes(res.status), `${chemin} a répondu ${res.status}`)
  }
})

test('Un utilisateur normal connecté n accède à aucune route admin', async () => {
  const agent = request.agent(app)
  const login = await agent.post('/api/auth/login')
    .send({ email: utilisateur.email, mot_de_passe: utilisateur.mot_de_passe })
  assert.equal(login.status, 200)
  for (const chemin of ROUTES_ADMIN) {
    const res = await agent.get(chemin)
    assert.ok([401, 403].includes(res.status), `${chemin} a répondu ${res.status}`)
  }
})

test('Un utilisateur normal ne peut pas supprimer un document ni un utilisateur', async () => {
  const agent = request.agent(app)
  await agent.post('/api/auth/login')
    .send({ email: utilisateur.email, mot_de_passe: utilisateur.mot_de_passe })
  const doc = await agent.delete('/api/admin/documents/1')
  const usr = await agent.delete('/api/admin/utilisateurs/1')
  assert.ok([401, 403].includes(doc.status), `documents : ${doc.status}`)
  assert.ok([401, 403].includes(usr.status), `utilisateurs : ${usr.status}`)
})

test('Un admin connecté accède au tableau de bord, sans mot de passe dans la réponse', async () => {
  const agent = request.agent(app)
  const login = await agent.post('/api/admin/login')
    .send({ email: admin.email, mot_de_passe: admin.mot_de_passe })
  assert.equal(login.status, 200, `connexion admin : ${login.status}`)
  assert.ok(!JSON.stringify(login.body).includes('mot_de_passe'))
  const res = await agent.get('/api/admin/dashboard')
  assert.equal(res.status, 200)
})

// Ce test doit rester le DERNIER du fichier : il bloque temporairement les connexions admin.
test('Après 5 échecs de connexion admin, la 6e tentative est bloquée (429)', async () => {
  let dernier
  for (let i = 0; i < 6; i++) {
    dernier = await request(app).post('/api/admin/login')
      .send({ email: admin.email, mot_de_passe: 'mauvais-mot-de-passe' })
  }
  assert.equal(dernier.status, 429)
})