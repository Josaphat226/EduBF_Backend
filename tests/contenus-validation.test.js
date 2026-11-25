'use strict'
// Tests purs (aucune base de données requise).
// Lancer : node --test tests/contenus-validation.test.js

const test = require('node:test')
const assert = require('node:assert/strict')

const { valider, calculerEmpreinte } = require('../services/contenus/validation')
const exemple = require('../services/contenus/exemples/exemple-exercice-3e.json')

const copie = o => JSON.parse(JSON.stringify(o))
const messages = r => r.erreurs.map(e => e.message)
const aUneErreur = (r, morceau) => messages(r).some(m => m.includes(morceau))

const texte = s => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] })

test('le document d’exemple est valide, sans erreur ni avertissement', () => {
  const r = valider(exemple, { pourPublication: true, bareme_total: 10 })
  assert.deepEqual(r.erreurs, [])
  assert.deepEqual(r.avertissements, [])
  assert.equal(r.ok, true)
  assert.equal(r.resume.total_points, 10)
  assert.equal(r.resume.nb_exercices, 2)
  assert.equal(r.resume.nb_questions, 8) // 6 questions + 2 sous-questions
  assert.ok(r.resume.nb_formules > 10)
})

// --- Schéma ---------------------------------------------------------------

test('schéma : une figure sans description (alt) est refusée', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].enonce.content.push({ type: 'figure', attrs: { src: 'contenus/x/fig.svg' } })
  const r = valider(d)
  assert.equal(r.ok, false)
  assert.ok(aUneErreur(r, 'alt'))
})

test('schéma : une formule sans latex est refusée', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].enonce.content.push({ type: 'formuleBloc', attrs: {} })
  assert.ok(aUneErreur(valider(d), 'latex'))
})

test('schéma : un type de nœud inconnu est refusé', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].enonce.content.push({ type: 'iframe' })
  assert.equal(valider(d).ok, false)
})

test('schéma : un titre de niveau 1 est refusé (niveaux 3 et 4 seulement)', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].enonce.content.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Titre' }] })
  assert.equal(valider(d).ok, false)
})

test('schéma : des points qui ne sont pas des multiples de 0,25 sont refusés', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].questions[0].points = 1.3
  assert.equal(valider(d).ok, false)
})

test('schéma : un exercice sans énoncé ni questions est refusé, avec un message clair', () => {
  const d = copie(exemple)
  d.parties[0].exercices.push({ id: 'exo-vide-1' })
  assert.ok(aUneErreur(valider(d), 'énoncé ou des questions'))
})

test('schéma : une vérification de mode inconnu est refusée', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].questions[2].verification = { mode: 'devinette', valeur: 1 }
  assert.ok(aUneErreur(valider(d), 'vérification invalide'))
})

// --- Règles métier --------------------------------------------------------

test('identifiants : un doublon est détecté et localisé', () => {
  const d = copie(exemple)
  d.parties[0].exercices[1].questions[0].id = 'qst-0001'
  const r = valider(d)
  assert.ok(aUneErreur(r, 'déjà utilisé'))
  assert.match(r.erreurs[0].libelle, /Exercice 2/)
})

test('points : le total d’une question chapeau doit égaler la somme de ses sous-questions', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].questions[1].points = 5
  assert.ok(aUneErreur(valider(d), 'sous-questions totalisent'))
})

test('points : le barème total de l’en-tête doit correspondre', () => {
  const d = copie(exemple)
  d.entete.bareme_total = 20
  assert.ok(aUneErreur(valider(d), 'barème total annoncé'))
})

test('points : le barème enregistré en base doit correspondre', () => {
  assert.ok(aUneErreur(valider(exemple, { bareme_total: 20 }), 'barème enregistré'))
})

test('points : le barème détaillé du corrigé doit égaler les points de la question', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].questions[0].corrige.bareme[0].points = 0.25
  assert.ok(aUneErreur(valider(d), 'barème du corrigé'))
})

test('profondeur : plus de 3 niveaux de sous-questions est refusé', () => {
  const d = copie(exemple)
  const feuille = (id) => ({ id, enonce: texte('x'), points: 1, corrige: { remarque: texte('y') } })
  const n3 = feuille('niv3-aaaa')
  const n2 = { id: 'niv2-aaaa', enonce: texte('x'), sous_questions: [{ id: 'niv2b-aaa', enonce: texte('x'), sous_questions: [n3] }] }
  d.parties[0].exercices.push({ id: 'exo-prof-1', questions: [{ id: 'niv1-aaaa', enonce: texte('x'), sous_questions: [n2] }] })
  assert.ok(aUneErreur(valider(d), 'imbriquées'))
})

test('corrigés : manquant = avertissement en brouillon, erreur à la publication', () => {
  const d = copie(exemple)
  delete d.parties[0].exercices[1].questions[2].corrige
  const brouillon = valider(d)
  assert.equal(brouillon.ok, true)
  assert.ok(brouillon.avertissements.some(a => a.message.includes('corrigé manquant')))
  const publication = valider(d, { pourPublication: true })
  assert.equal(publication.ok, false)
  assert.ok(aUneErreur(publication, 'corrigé manquant'))
})

test('QCM : une bonne réponse absente des propositions est détectée', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].questions[2].verification = {
    mode: 'qcm',
    propositions: [{ id: 'prop-aaaa', texte: 'A' }, { id: 'prop-bbbb', texte: 'B' }],
    correctes: ['prop-zzzz']
  }
  assert.ok(aUneErreur(valider(d), 'pas parmi les propositions'))
})

test('LaTeX : une formule invalide est détectée avec son emplacement', () => {
  const d = copie(exemple)
  d.parties[0].exercices[0].enonce.content.push({ type: 'formuleBloc', attrs: { latex: '\\frac{1}{' } })
  const r = valider(d)
  assert.ok(aUneErreur(r, 'formule LaTeX invalide'))
  assert.match(r.erreurs[0].libelle, /Exercice 1/)
})

test('LaTeX : sans KaTeX, un avertissement remplace la vérification', () => {
  const r = valider(exemple, { katex: null })
  assert.equal(r.ok, true)
  assert.ok(r.avertissements.some(a => a.message.includes('KaTeX')))
})

// --- Empreinte ------------------------------------------------------------

test('empreinte : identique quel que soit l’ordre des clés', () => {
  const a = { x: 1, y: { b: 2, a: [1, 2, { z: 1, w: 2 }] } }
  const b = { y: { a: [1, 2, { w: 2, z: 1 }], b: 2 }, x: 1 }
  assert.equal(calculerEmpreinte(a), calculerEmpreinte(b))
  assert.equal(calculerEmpreinte(a).length, 64)
})

test('empreinte : change dès que le contenu change', () => {
  const d = copie(exemple)
  const avant = calculerEmpreinte(d)
  d.parties[0].exercices[0].questions[0].points = 2.25
  assert.notEqual(avant, calculerEmpreinte(d))
})


// --- Figures (schémas SVG importés) ----------------------------------------

const CHEMIN_FIGURE = 'contenus/' + 'a'.repeat(64) + '.svg'
const avecFigure = (attrs) => {
  const d = copie(exemple)
  d.parties[0].exercices[0].enonce.content.push({ type: 'figure', attrs })
  return d
}

test('figure : un chemin issu de l’envoi de fichier est accepté', () => {
  const r = valider(avecFigure({ src: CHEMIN_FIGURE, alt: 'Circuit série avec une pile et deux résistances', credit: 'Schéma EduBF' }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.resume.figures, [CHEMIN_FIGURE])
  assert.deepEqual(r.avertissements, [])
})

test('figure : sans crédit ni source, un avertissement est émis (non bloquant)', () => {
  const r = valider(avecFigure({ src: CHEMIN_FIGURE, alt: 'Circuit série avec une pile et deux résistances' }), { pourPublication: true })
  assert.equal(r.ok, true)
  assert.ok(r.avertissements.some(a => a.message.includes('sans crédit')))
})

test('figure : une adresse externe est refusée', () => {
  assert.equal(valider(avecFigure({ src: 'https://exemple.org/circuit.svg', alt: 'Circuit' })).ok, false)
})

test('figure : un chemin qui sort du dossier est refusé', () => {
  assert.equal(valider(avecFigure({ src: 'contenus/../secret.svg', alt: 'Circuit' })).ok, false)
  assert.equal(valider(avecFigure({ src: 'contenus/abc.svg', alt: 'Circuit' })).ok, false)
})
