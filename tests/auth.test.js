require('./setup')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const app = require('../server')
const { creerUtilisateur, nettoyer, fermer } = require('./helpers')

let utilisateur

before(async () => {
  await nettoyer()
  utilisateur = await creerUtilisateur('auth')
})

after(async () => {
  await nettoyer()
  await fermer()
})

test('Connexion avec bon mot de passe : réussie, sans mot de passe dans la réponse', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: utilisateur.email, mot_de_passe: utilisateur.mot_de_passe })
  assert.equal(res.status, 200)
  assert.ok(!JSON.stringify(res.body).includes('mot_de_passe'))
})

test('Connexion avec mauvais mot de passe : refusée', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: utilisateur.email, mot_de_passe: 'mauvais-mot-de-passe' })
  assert.ok([400, 401].includes(res.status), `statut reçu : ${res.status}`)
})

test('Après connexion, /auth/me renvoie l utilisateur', async () => {
  const agent = request.agent(app)
  await agent.post('/api/auth/login')
    .send({ email: utilisateur.email, mot_de_passe: utilisateur.mot_de_passe })
  const res = await agent.get('/api/auth/me')
  assert.equal(res.status, 200)
  assert.ok(JSON.stringify(res.body).includes(utilisateur.email))
  assert.ok(!JSON.stringify(res.body).includes('mot_de_passe'))
})

test('Sans connexion : favoris, mes-sessions et profil sont refusés', async () => {
  for (const chemin of ['/api/favoris', '/api/concours/mes-sessions', '/api/auth/profile/full']) {
    const res = await request(app).get(chemin)
    assert.equal(res.status, 401, `${chemin} a répondu ${res.status}`)
  }
})