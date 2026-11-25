'use strict'
/**
 * VALIDATION DES CONTENUS PÉDAGOGIQUES
 *
 * valider(doc, options) vérifie un document au format schema-v1.json :
 *   1. la structure (JSON Schema, via Ajv) ;
 *   2. les règles que le schéma ne sait pas exprimer :
 *        - identifiants uniques dans tout le document ;
 *        - profondeur maximale des sous-questions ;
 *        - cohérence des points ;
 *        - présence des corrigés ;
 *        - cohérence des QCM ;
 *        - formules LaTeX valides (si KaTeX est installé).
 *
 * options.pourPublication (défaut false) : un corrigé manquant devient une
 *   erreur bloquante au lieu d'un simple avertissement.
 * options.bareme_total : total attendu (colonne contenus.bareme_total).
 * options.katex : instance KaTeX à utiliser (null pour désactiver la vérification).
 */

const crypto = require('crypto')
const Ajv = require('ajv')
const schema = require('./schema-v1.json')

const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false })
const verifierSchema = ajv.compile(schema)

const PROFONDEUR_MAX_QUESTIONS = 3 // question > sous-question > sous-sous-question
const EPSILON = 1e-9

// ---------------------------------------------------------------------------
// Erreurs de schéma lisibles
// ---------------------------------------------------------------------------

function chemin(instancePath) {
  // "/parties/0/exercices/1" -> "parties[0].exercices[1]"
  return instancePath
    .split('/')
    .filter(Boolean)
    .map(s => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`))
    .join('')
    .replace(/^\./, '')
}

function erreursDeSchema(erreursAjv) {
  // Ajv exprime schemaPath relativement à la définition référencée : on se
  // repère donc au chemin de l'instance et au mot-clé.
  const verifsEnErreur = erreursAjv
    .filter(e => e.keyword === 'oneOf' && /\/verification$/.test(e.instancePath))
    .map(e => e.instancePath)
  const exercicesSansContenu = erreursAjv
    .filter(e => e.keyword === 'anyOf' && /\/exercices\/\d+$/.test(e.instancePath))
    .map(e => e.instancePath)

  const vus = new Set()
  const sortie = []
  for (const e of erreursAjv) {
    if (e.keyword === 'if') continue // bruit : le détail est dans les erreurs du "then"

    // Vérification de mode inconnu / incomplet : un seul message au lieu d'une erreur par branche
    const dansVerif = verifsEnErreur.find(p => e.instancePath === p || e.instancePath.startsWith(p + '/'))
    if (dansVerif && e.keyword !== 'oneOf') continue

    // Exercice sans énoncé ni questions : idem pour les deux branches du anyOf
    if (e.keyword === 'required' && exercicesSansContenu.includes(e.instancePath)
        && ['enonce', 'questions'].includes(e.params.missingProperty)) continue

    let message = e.message
    if (e.keyword === 'oneOf' && dansVerif) {
      message = 'vérification invalide (mode inconnu ou champs manquants)'
    } else if (e.keyword === 'anyOf' && exercicesSansContenu.includes(e.instancePath)) {
      message = 'un exercice doit avoir un énoncé ou des questions'
    } else if (e.keyword === 'required') {
      message = `champ obligatoire manquant : ${e.params.missingProperty}`
    } else if (e.keyword === 'additionalProperties') {
      message = `champ non autorisé : ${e.params.additionalProperty}`
    } else if (e.keyword === 'enum') {
      message = `valeur non autorisée (attendu : ${e.params.allowedValues.join(', ')})`
    }
    const c = chemin(e.instancePath)
    const cle = `${c}|${message}`
    if (vus.has(cle)) continue
    vus.add(cle)
    sortie.push({ chemin: c || '(racine)', libelle: null, message })
  }
  return sortie
}

// ---------------------------------------------------------------------------
// Parcours du texte riche
// ---------------------------------------------------------------------------

function parcourirNoeuds(noeud, visiteur) {
  visiteur(noeud)
  if (Array.isArray(noeud.content)) noeud.content.forEach(n => parcourirNoeuds(n, visiteur))
}

function documentsDuCorrige(corrige) {
  if (!corrige) return []
  const liste = []
  for (const cle of ['reponse_attendue', 'methode', 'remarque']) {
    if (corrige[cle]) liste.push([`corrige.${cle}`, corrige[cle]])
  }
  ;(corrige.etapes || []).forEach((e, i) => liste.push([`corrige.etapes[${i}].doc`, e.doc]))
  return liste
}

// ---------------------------------------------------------------------------
// Libellés lisibles pour l'admin (« Exercice 2 › Question 3 › b) »)
// ---------------------------------------------------------------------------

const ROMAINS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']

function libelleQuestion(q, index, profondeur) {
  if (q.etiquette) return q.etiquette
  if (profondeur === 0) return `Question ${index + 1}`
  if (profondeur === 1) return `${String.fromCharCode(97 + (index % 26))})`
  return `${ROMAINS[index] || index + 1})`
}

// ---------------------------------------------------------------------------
// Règles métier
// ---------------------------------------------------------------------------

function analyser(doc, options) {
  const erreurs = []
  const avertissements = []
  const ids = new Map()
  const resume = { nb_exercices: 0, nb_questions: 0, nb_formules: 0, figures: [], total_points: 0 }

  const erreur = (c, libelle, message) => erreurs.push({ chemin: c, libelle, message })
  const avert = (c, libelle, message) => avertissements.push({ chemin: c, libelle, message })
  const manque = (c, libelle, message) => (options.pourPublication ? erreur : avert)(c, libelle, message)

  let katex = options.katex
  if (katex === undefined) {
    try { katex = require('katex') } catch (_) { katex = null }
  }
  if (!katex) {
    avert('(formules)', null, 'KaTeX n’est pas installé : la validité des formules n’est pas vérifiée.')
  }

  function enregistrerId(id, c, libelle) {
    if (ids.has(id)) erreur(c, libelle, `identifiant « ${id} » déjà utilisé à ${ids.get(id)}`)
    else ids.set(id, c)
  }

  function verifierRiche(richeDoc, c, libelle) {
    parcourirNoeuds(richeDoc, n => {
      if (n.type === 'formuleInline' || n.type === 'formuleBloc') {
        resume.nb_formules++
        if (katex) {
          try {
            katex.renderToString(n.attrs.latex, { throwOnError: true, displayMode: n.type === 'formuleBloc' })
          } catch (e) {
            erreur(c, libelle, `formule LaTeX invalide « ${n.attrs.latex.slice(0, 60)} » : ${String(e.message).replace(/^KaTeX parse error: /, '')}`)
          }
        }
      } else if (n.type === 'figure') {
        resume.figures.push(n.attrs.src)
        if (!n.attrs.credit) {
          avert(c, libelle, `figure « ${n.attrs.alt.slice(0, 40)} » sans crédit ni source (provenance et licence à indiquer)`)
        }
      }
    })
  }

  function verifierCorrige(corrige, c, libelle, pointsNoeud) {
    for (const [nom, d] of documentsDuCorrige(corrige)) verifierRiche(d, `${c}.${nom}`, libelle)
    if (corrige && corrige.bareme && pointsNoeud != null) {
      const somme = corrige.bareme.reduce((s, b) => s + b.points, 0)
      if (Math.abs(somme - pointsNoeud) > EPSILON) {
        erreur(`${c}.corrige.bareme`, libelle, `le barème du corrigé totalise ${somme} point(s) alors que l’élément en vaut ${pointsNoeud}`)
      }
    }
  }

  function verifierAnnexes(annexes, c, libelle) {
    ;(annexes || []).forEach((a, i) => {
      const ca = `${c}.annexes[${i}]`
      enregistrerId(a.id, ca, libelle)
      verifierRiche(a.doc, `${ca}.doc`, `${libelle} › Annexe « ${a.titre} »`)
    })
  }

  // Retourne le total de points de la question
  function traiterQuestion(q, c, libelle, profondeur) {
    resume.nb_questions++
    enregistrerId(q.id, c, libelle)
    if (profondeur >= PROFONDEUR_MAX_QUESTIONS) {
      erreur(c, libelle, `les questions ne peuvent pas être imbriquées sur plus de ${PROFONDEUR_MAX_QUESTIONS} niveaux`)
    }
    verifierRiche(q.enonce, `${c}.enonce`, libelle)

    // Vérification automatique (mode interactif)
    if (q.verification) {
      if (q.sous_questions) {
        erreur(`${c}.verification`, libelle, 'une question qui a des sous-questions ne peut pas avoir de vérification automatique')
      }
      if (q.verification.mode === 'qcm') {
        const idsProps = q.verification.propositions.map(p => p.id)
        if (new Set(idsProps).size !== idsProps.length) {
          erreur(`${c}.verification`, libelle, 'deux propositions ont le même identifiant')
        }
        for (const bonne of q.verification.correctes) {
          if (!idsProps.includes(bonne)) {
            erreur(`${c}.verification`, libelle, `la réponse correcte « ${bonne} » n’est pas parmi les propositions`)
          }
        }
      }
    }

    let total
    if (q.sous_questions) {
      let somme = 0
      q.sous_questions.forEach((sq, i) => {
        somme += traiterQuestion(sq, `${c}.sous_questions[${i}]`, `${libelle} › ${libelleQuestion(sq, i, profondeur + 1)}`, profondeur + 1)
      })
      if (q.points != null && Math.abs(q.points - somme) > EPSILON) {
        erreur(c, libelle, `${q.points} point(s) indiqué(s) mais les sous-questions totalisent ${somme}`)
      }
      total = q.points != null ? q.points : somme
      // Une question « chapeau » n'a pas besoin de corrigé : ses sous-questions en ont un.
      if (q.corrige) verifierCorrige(q.corrige, c, libelle, total)
    } else {
   
      if (!q.corrige) manque(c, libelle, 'corrigé manquant')
      else verifierCorrige(q.corrige, c, libelle, q.points)
      total = q.points != null ? q.points : 0
    }
    return total
  }

  function traiterExercice(ex, c, libelle) {
    resume.nb_exercices++
    enregistrerId(ex.id, c, libelle)
    if (ex.enonce) verifierRiche(ex.enonce, `${c}.enonce`, libelle)
    verifierAnnexes(ex.annexes, c, libelle)

    let total
    if (ex.questions) {
      let somme = 0
      ex.questions.forEach((q, i) => {
        somme += traiterQuestion(q, `${c}.questions[${i}]`, `${libelle} › ${libelleQuestion(q, i, 0)}`, 0)
      })
      if (ex.points != null && Math.abs(ex.points - somme) > EPSILON) {
        erreur(c, libelle, `${ex.points} point(s) indiqué(s) mais les questions totalisent ${somme}`)
      }
      total = ex.points != null ? ex.points : somme
      if (ex.corrige) verifierCorrige(ex.corrige, c, libelle, total)
    } else {
      // Problème sans question numérotée : le corrigé est porté par l'exercice

      if (!ex.corrige) manque(c, libelle, 'corrigé manquant')
      else verifierCorrige(ex.corrige, c, libelle, ex.points)
      total = ex.points != null ? ex.points : 0
    }
    return total
  }

  // --- En-tête
  if (doc.entete && doc.entete.consignes) verifierRiche(doc.entete.consignes, 'entete.consignes', 'En-tête')

  // --- Parties
  let totalGeneral = 0
  doc.parties.forEach((partie, i) => {
    const cp = `parties[${i}]`
    const lp = partie.titre ? `Partie ${i + 1} (${partie.titre})` : `Partie ${i + 1}`
    enregistrerId(partie.id, cp, lp)
    if (partie.consignes) verifierRiche(partie.consignes, `${cp}.consignes`, lp)
    verifierAnnexes(partie.annexes, cp, lp)

    let sommePartie = 0
    partie.exercices.forEach((ex, j) => {
      const label = ex.etiquette || `Exercice ${j + 1}`
      sommePartie += traiterExercice(ex, `${cp}.exercices[${j}]`, `${lp} › ${label}`)
    })
    if (partie.points != null && Math.abs(partie.points - sommePartie) > EPSILON) {
      erreur(cp, lp, `${partie.points} point(s) indiqué(s) mais les exercices totalisent ${sommePartie}`)
    }
    totalGeneral += partie.points != null ? partie.points : sommePartie
  })

  resume.total_points = totalGeneral
 

  // --- Total annoncé
  const annonce = doc.entete && doc.entete.bareme_total
  if (annonce != null && Math.abs(annonce - totalGeneral) > EPSILON) {
    erreur('entete.bareme_total', 'En-tête', `le barème total annoncé (${annonce}) ne correspond pas à la somme des points (${totalGeneral})`)
  }
  if (options.bareme_total != null && Math.abs(Number(options.bareme_total) - totalGeneral) > EPSILON) {
    erreur('(barème)', null, `le barème enregistré pour ce contenu (${options.bareme_total}) ne correspond pas à la somme des points (${totalGeneral})`)
  }

  resume.duree_minutes = (doc.entete && doc.entete.duree_minutes) || null
  resume.figures = [...new Set(resume.figures)]
  return { erreurs, avertissements, resume }
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

function valider(doc, options = {}) {
  if (!verifierSchema(doc)) {
    return { ok: false, erreurs: erreursDeSchema(verifierSchema.errors), avertissements: [], resume: null }
  }
  const { erreurs, avertissements, resume } = analyser(doc, options)
  return { ok: erreurs.length === 0, erreurs, avertissements, resume }
}

// JSON canonique (clés triées) : deux documents identiques donnent la même
// empreinte, quel que soit l'ordre des clés renvoyé par PostgreSQL/JSONB.
function canonique(valeur) {
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`
  if (valeur && typeof valeur === 'object') {
    return `{${Object.keys(valeur).sort().map(k => `${JSON.stringify(k)}:${canonique(valeur[k])}`).join(',')}}`
  }
  return JSON.stringify(valeur)
}

function calculerEmpreinte(doc) {
  return crypto.createHash('sha256').update(canonique(doc)).digest('hex')
}

module.exports = { valider, calculerEmpreinte, PROFONDEUR_MAX_QUESTIONS }