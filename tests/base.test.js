require('./setup')
const test = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const app = require('../server')

test('GET /health répond OK', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
})

test('Une route inconnue renvoie 404 en JSON', async () => {
  const res = await request(app).get('/api/route-qui-nexiste-pas')
  assert.equal(res.status, 404)
  assert.ok(res.body.error)
})

test('La liste publique des documents ne contient ni fichier_url ni admin_id', async () => {
  const res = await request(app).get('/api/documents')
  assert.equal(res.status, 200)
  const texte = JSON.stringify(res.body)
  assert.ok(!texte.includes('fichier_url'))
  assert.ok(!texte.includes('admin_id'))
})