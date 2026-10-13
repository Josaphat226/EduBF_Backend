require('./setup')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const app = require('../server')
const { pool, creerUtilisateur, nettoyer, fermer } = require('./helpers')

let agentA, agentB, serieId, sessionId, sqId, bonneId, mauvaiseId

async function nettoyerDonneesConcours() {
  await nettoyer()
  const d = `SELECT id FROM concours.domaines WHERE nom = 'TEST domaine'`
  const q = `SELECT id FROM concours.questions WHERE domaine_id IN (${d})`
  const s = `SELECT id FROM concours.series WHERE domaine_id IN (${d})`
  await pool.query(`DELETE FROM concours.serie_questions WHERE serie_id IN (${s})`)
  await pool.query(`DELETE FROM concours.series WHERE domaine_id IN (${d})`)
  await pool.query(`DELETE FROM concours.propositions WHERE question_id IN (${q})`)
  await pool.query(`DELETE FROM concours.questions WHERE domaine_id IN (${d})`)
  await pool.query(`DELETE FROM concours.domaines WHERE nom = 'TEST domaine'`)
}

before(async () => {
  await nettoyerDonneesConcours()

  const dom = await pool.query(
    `INSERT INTO concours.domaines (nom, icone, ordre, actif) VALUES ('TEST domaine','x',999,true) RETURNING id`)
  const domaineId = dom.rows[0].id

  const q = await pool.query(
    `INSERT INTO concours.questions (domaine_id, type, enonce, difficulte, statut)
     VALUES ($1,'qcm','2 + 2 = ?','facile','publiee') RETURNING id`, [domaineId])
  const questionId = q.rows[0].id

  const p1 = await pool.query(
    `INSERT INTO concours.propositions (question_id, texte, est_correcte, ordre) VALUES ($1,'4',true,0) RETURNING id`, [questionId])
  const p2 = await pool.query(
    `INSERT INTO concours.propositions (question_id, texte, est_correcte, ordre) VALUES ($1,'5',false,1) RETURNING id`, [questionId])
  bonneId = p1.rows[0].id
  mauvaiseId = p2.rows[0].id

  const s = await pool.query(
    `INSERT INTO concours.series (domaine_id, titre, difficulte, nb_questions_cible, statut)
     VALUES ($1,'TEST série','facile',1,'publiee') RETURNING id`, [domaineId])
  serieId = s.rows[0].id
  await pool.query(
    `INSERT INTO concours.serie_questions (serie_id, question_id, ordre) VALUES ($1,$2,0)`, [serieId, questionId])

  const userA = await creerUtilisateur('concoursA')
  const userB = await creerUtilisateur('concoursB')
  agentA = request.agent(app)
  agentB = request.agent(app)
  const loginA = await agentA.post('/api/auth/login').send({ email: userA.email, mot_de_passe: userA.mot_de_passe })
  const loginB = await agentB.post('/api/auth/login').send({ email: userB.email, mot_de_passe: userB.mot_de_passe })
  assert.equal(loginA.status, 200, `Connexion de A échouée : ${loginA.status}`)
  assert.equal(loginB.status, 200, `Connexion de B échouée : ${loginB.status}`)
})

after(async () => {
  await nettoyerDonneesConcours()
  await fermer()
})

test('A crée une session de concours', async () => {
  const res = await agentA.post('/api/concours/sessions').send({ serie_id: serieId })
  assert.equal(res.status, 201)
  sessionId = res.body.session_id
  assert.ok(sessionId)
  const { rows } = await pool.query('SELECT id FROM concours.session_questions WHERE session_id = $1', [sessionId])
  sqId = rows[0].id
})

test('Une demande sans domaine ni série est refusée', async () => {
  const res = await agentA.post('/api/concours/sessions').send({ domaine_ids: [] })
  assert.equal(res.status, 400)
})

test('Un identifiant de session non numérique renvoie 404', async () => {
  const res = await agentA.get('/api/concours/sessions/abc')
  assert.equal(res.status, 404)
})

test('Le quiz en cours ne révèle pas les bonnes réponses', async () => {
  const res = await agentA.get(`/api/concours/sessions/${sessionId}`)
  assert.equal(res.status, 200)
  assert.ok(!JSON.stringify(res.body).includes('"correcte":true'))
})

test('B ne peut ni lire, ni répondre, ni terminer, ni voir le résultat de la session de A', async () => {
  const lire = await agentB.get(`/api/concours/sessions/${sessionId}`)
  assert.equal(lire.status, 404)

  const repondre = await agentB.post(`/api/concours/sessions/${sessionId}/reponses`)
    .send({ session_question_id: sqId, proposition_choisie_id: bonneId })
  assert.equal(repondre.status, 404)

  const terminer = await agentB.put(`/api/concours/sessions/${sessionId}/terminer`).send({})
  assert.equal(terminer.status, 404)

  const resultat = await agentB.get(`/api/concours/sessions/${sessionId}/resultat`)
  assert.equal(resultat.status, 404)
})

test('A répond une fois : accepté. Une deuxième fois à la même question : 409', async () => {
  const r1 = await agentA.post(`/api/concours/sessions/${sessionId}/reponses`)
    .send({ session_question_id: sqId, proposition_choisie_id: bonneId })
  assert.equal(r1.status, 201)

  const r2 = await agentA.post(`/api/concours/sessions/${sessionId}/reponses`)
    .send({ session_question_id: sqId, proposition_choisie_id: mauvaiseId })
  assert.equal(r2.status, 409)
})

test('Terminer : le score est calculé par le serveur (1 bonne réponse = score 1)', async () => {
  const res = await agentA.put(`/api/concours/sessions/${sessionId}/terminer`).send({ score: 999 })
  assert.equal(res.status, 200)
  assert.equal(res.body.score, 1)
})

test('Session terminée : on ne peut plus répondre', async () => {
  const res = await agentA.post(`/api/concours/sessions/${sessionId}/reponses`)
    .send({ session_question_id: sqId, proposition_choisie_id: bonneId })
  assert.equal(res.status, 404)
})