/**
 * PIPELINE D'IMPORT CONCOURS
 * Format brut (TXT/CSV/JSON) -> schema pivot -> validation stricte.
 * Le format source est cense contenir DEJA toutes les informations
 * (domaine, difficulte, reponse) — aucune detection/devinette ici.
 */

const { parse: parseCsvSync } = require('csv-parse/sync')

const ALIASES = {
  domaine: ['domaine', 'categorie', 'matiere', 'domain', 'category'],
  type: ['type', 'type_question'],
  difficulte: ['difficulte', 'difficulté', 'difficulty', 'niveau'],
  enonce: ['enonce', 'énoncé', 'question', 'texte', 'intitule', 'texte_question'],
  reponse_texte: ['reponse', 'réponse', 'reponse_texte', 'answer', 'bonne_reponse', 'correct'],
  explication: ['explication', 'correction', 'justification', 'explanation'],
  source: ['source', 'origine'],
}

const DIFFICULTES_VALIDES = ['facile', 'moyen', 'difficile']

function trouverChamp(objet, cles) {
  const clesObjet = Object.keys(objet)
  for (const alias of cles) {
    const trouve = clesObjet.find(k => k.toLowerCase().trim() === alias)
    if (trouve && objet[trouve] !== undefined && objet[trouve] !== '') return objet[trouve]
  }
  return null
}

function detecterPropositionsDepuisObjet(objet) {
  const champsPossibles = ['propositions', 'choix', 'options', 'reponses_possibles']

  // Cas 1 : un tableau de propositions (deja gere avant)
  const champTableau = champsPossibles.map(a => objet[a]).find(v => Array.isArray(v))
  if (champTableau) {
    return champTableau.map(p =>
      typeof p === 'string' ? { texte: p, correcte: false } : { texte: p.texte || p.text || '', correcte: !!(p.correcte || p.correct) }
    )
  }

  // Cas 2 (NOUVEAU) : un objet de propositions, ex. { "A": "INSERT", "B": "UPDATE", ... }
  // avec la bonne reponse donnee a part (ex. "reponse": "C")
  const champObjet = champsPossibles.map(a => objet[a]).find(v => v && typeof v === 'object' && !Array.isArray(v))
  if (champObjet) {
    const reponseLettre = (trouverChamp(objet, ALIASES.reponse_texte) || '').toString().trim().toLowerCase()
    return Object.entries(champObjet).map(([lettre, texte]) => ({
      texte: String(texte),
      correcte: lettre.trim().toLowerCase() === reponseLettre,
    }))
  }

  // Cas 3 : colonnes separees optionA/optionB... (deja gere avant, pour le CSV surtout)
  const lettres = ['a', 'b', 'c', 'd', 'e', 'f']
  const props = []
  for (const lettre of lettres) {
    const cle = Object.keys(objet).find(k => k.toLowerCase().replace(/[_\s]/g, '') === `option${lettre}` || k.toLowerCase() === lettre)
    if (cle && objet[cle]) props.push({ lettre, texte: objet[cle], correcte: false })
  }
  if (props.length > 0) {
    const reponseLettre = (trouverChamp(objet, ALIASES.reponse_texte) || '').toString().trim().toLowerCase()
    props.forEach(p => { p.correcte = p.lettre === reponseLettre })
    return props.map(({ texte, correcte }) => ({ texte, correcte }))
  }

  return null
}

// ---------- Parseur JSON ----------
function parserJSON(contenu) {
  const data = JSON.parse(contenu)
  const items = Array.isArray(data) ? data : (data.questions || [])
  return items.map(objet => ({
    domaine: trouverChamp(objet, ALIASES.domaine),
    type: trouverChamp(objet, ALIASES.type),
    difficulte: trouverChamp(objet, ALIASES.difficulte),
    enonce: trouverChamp(objet, ALIASES.enonce),
    propositions: detecterPropositionsDepuisObjet(objet),
    reponse_texte: trouverChamp(objet, ALIASES.reponse_texte),
    explication: trouverChamp(objet, ALIASES.explication),
    source: trouverChamp(objet, ALIASES.source),
  }))
}

// ---------- Parseur CSV ----------
function parserCSV(contenu) {
  const lignes = parseCsvSync(contenu, { columns: true, skip_empty_lines: true, bom: true })
  return lignes.map(objet => ({
    domaine: trouverChamp(objet, ALIASES.domaine),
    type: trouverChamp(objet, ALIASES.type),
    difficulte: trouverChamp(objet, ALIASES.difficulte),
    enonce: trouverChamp(objet, ALIASES.enonce),
    propositions: detecterPropositionsDepuisObjet(objet),
    reponse_texte: trouverChamp(objet, ALIASES.reponse_texte),
    explication: trouverChamp(objet, ALIASES.explication),
    source: trouverChamp(objet, ALIASES.source),
  }))
}

// ---------- Parseur TXT ----------
// Format attendu (voir exemple fourni) :
//   1. Enonce ?
//   A) Option
//   B) Option
//   Réponse: B
//   Explication: ...
//   Domaine: ...
//   Difficulté: ...
function parserTXT(contenu) {
  const lignes = contenu.split(/\r?\n/)
  const blocs = []
  let blocCourant = null

  const debutQuestion = /^\s*\d+[.)]\s*/
  const ligneOption = /^\s*([A-Fa-f])[.)]\s*(.+)/
  const ligneReponse = /^\s*(r[ée]ponse|rep|answer)\s*[:\-]\s*(.+)/i
  const ligneExplication = /^\s*(explication|correction|justification)\s*[:\-]\s*(.+)/i
  const ligneDomaine = /^\s*(domaine|cat[ée]gorie|matiere|mati[èe]re)\s*[:\-]\s*(.+)/i
  const ligneDifficulte = /^\s*(difficult[ée])\s*[:\-]\s*(.+)/i

  for (const ligneBrute of lignes) {
    const ligne = ligneBrute.trim()
    if (!ligne) continue

    if (debutQuestion.test(ligne)) {
      if (blocCourant) blocs.push(blocCourant)
      blocCourant = { enonce: ligne.replace(debutQuestion, ''), propositions: [], reponseLettre: null, explication: null, domaine: null, difficulte: null }
      continue
    }
    if (!blocCourant) {
      blocCourant = { enonce: ligne, propositions: [], reponseLettre: null, explication: null, domaine: null, difficulte: null }
      continue
    }

    const matchOption = ligne.match(ligneOption)
    if (matchOption) {
      blocCourant.propositions.push({ lettre: matchOption[1].toLowerCase(), texte: matchOption[2] })
      continue
    }
    const matchReponse = ligne.match(ligneReponse)
    if (matchReponse) { blocCourant.reponseLettre = matchReponse[2].trim().toLowerCase(); continue }

    const matchExplication = ligne.match(ligneExplication)
    if (matchExplication) { blocCourant.explication = matchExplication[2].trim(); continue }

    const matchDomaine = ligne.match(ligneDomaine)
    if (matchDomaine) { blocCourant.domaine = matchDomaine[2].trim(); continue }

    const matchDifficulte = ligne.match(ligneDifficulte)
    if (matchDifficulte) { blocCourant.difficulte = matchDifficulte[2].trim(); continue }

    blocCourant.enonce += ' ' + ligne
  }
  if (blocCourant) blocs.push(blocCourant)

  return blocs.map(b => ({
    domaine: b.domaine,
    type: b.propositions.length > 0 ? 'qcm' : 'reponse_libre',
    difficulte: b.difficulte,
    enonce: b.enonce,
    propositions: b.propositions.length > 0
      ? b.propositions.map(p => ({ texte: p.texte, correcte: p.lettre === b.reponseLettre }))
      : null,
    reponse_texte: b.propositions.length === 0 ? b.reponseLettre : null,
    explication: b.explication,
    source: null,
  }))
}

// Parseurs seuls, sans validation -- utilise par la route d'execution
function analyserFichierBrut(contenu, format) {
  if (format === 'json') return parserJSON(contenu)
  if (format === 'csv') return parserCSV(contenu)
  if (format === 'txt') return parserTXT(contenu)
  throw new Error('Format non supporte: ' + format)
}

// ---------- Validation stricte (remplace l'ancien "classement" flou) ----------
function validerEtClasser(q, domainesConnus) {
  if (!q.enonce || !q.enonce.trim()) {
    return { rejetee: true, erreurs: ['Énoncé manquant'] }
  }

  const erreurs = []

  const domaineTrouve = q.domaine
    ? domainesConnus.find(d => d.nom.toLowerCase() === q.domaine.trim().toLowerCase())
    : null
  if (!domaineTrouve) erreurs.push(`Domaine manquant ou non reconnu${q.domaine ? ` ("${q.domaine}")` : ''}`)

  const ALIAS_DIFFICULTE = { moyenne: 'moyen', difficille: 'difficile', dificile: 'difficile', facil: 'facile' }
const brute = q.difficulte ? q.difficulte.trim().toLowerCase() : null
const difficulteNormalisee = brute ? (ALIAS_DIFFICULTE[brute] || brute) : null
  const difficulteValide = difficulteNormalisee && DIFFICULTES_VALIDES.includes(difficulteNormalisee)
  if (!difficulteValide) erreurs.push(`Difficulté manquante ou invalide${q.difficulte ? ` ("${q.difficulte}")` : ''}`)

  const aDesPropositions = Array.isArray(q.propositions) && q.propositions.length > 0
  const nbCorrectes = aDesPropositions ? q.propositions.filter(p => p.correcte).length : 0

  if (!aDesPropositions && !q.reponse_texte) {
    erreurs.push('Options manquantes (ni QCM, ni réponse texte)')
  } else if (aDesPropositions && nbCorrectes === 0) {
    erreurs.push('Aucune option marquée comme la bonne réponse')
  } else if (aDesPropositions && nbCorrectes > 1) {
    erreurs.push('Plusieurs options marquées comme correctes (ambiguë)')
  }

  return {
    rejetee: false,
    valide: erreurs.length === 0,
    erreurs,
    domaine_id: domaineTrouve ? domaineTrouve.id : null,
    difficulte: difficulteValide ? difficulteNormalisee : null,
  }
}

module.exports = { analyserFichierBrut, validerEtClasser }