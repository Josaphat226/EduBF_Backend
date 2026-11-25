#!/usr/bin/env node
/*
 importer.js - importe les documents de manifeste.csv dans EduBF (Supabase Storage + base).

 Mettre ce fichier dans le dossier du BACKEND (la ou se trouvent pg et @supabase/supabase-js),
 avec un fichier .env.import a cote (voir plus bas).

 Par defaut : SIMULATION (aucune ecriture, ni en base ni en Storage).

 Exemples :
   node importer.js --projet=REF                         simulation
   node importer.js --projet=REF --appliquer --limite=5  vrai import de 5 documents (test)
   node importer.js --projet=REF --appliquer             import complet
   node importer.js --projet=REF --annuler               liste ce qui serait annule
   node importer.js --projet=REF --annuler --appliquer   annule l'import (supprime import-*)
   node importer.js --hors-ligne                         test local des titres/mappings, sans connexion

 .env.import :
   IMPORT_DATABASE_URL=postgresql://postgres.REF:MOT%40DE%40PASSE@aws-0-...pooler.supabase.com:6543/postgres
   IMPORT_SUPABASE_URL=https://REF.supabase.co
   IMPORT_SUPABASE_SERVICE_KEY=...cle service_role...
 (REF = identifiant du projet ; il doit etre identique dans les 3 et dans --projet=REF)
 Dans le mot de passe, encoder les caracteres speciaux : @ devient %40
*/
const fs = require('fs')
const path = require('path')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]
}))

const APPLIQUER = !!args.appliquer
const HORS_LIGNE = !!args['hors-ligne']
const ANNULER = !!args.annuler
const LIMITE = args.limite ? parseInt(args.limite, 10) : Infinity
const ADMIN_ID = args['admin-id'] ? parseInt(args['admin-id'], 10) : null
const DOSSIER = args.dossier || 'C:\\Users\\SAWADOGO Josaphat\\Documents\\other\\other\\documents_compresses'
const MANIFESTE = args.manifeste || path.join(__dirname, 'manifeste.csv')
const BUCKET = 'documents'
const PREFIXE = 'import-'
const STATUT = 'en_attente'          // jamais publie automatiquement

// ---------------------------------------------------------------- referentiels
const EXAMEN = { bac: 8, bts: 9, bep: 10, cap: 11, superieur: 12 }
function examenDe(niveau) {
  if (niveau === 'superieur') return EXAMEN.superieur
  return EXAMEN[niveau.split('-')[0]] || null
}
function niveauScolaire(niveau) {            // champ texte "niveau" deja utilise dans tes documents
  return (niveau.startsWith('bts') || niveau === 'superieur') ? 'Supérieur' : 'Lycée'
}
// series_filieres (ids reels de ta base)
const SERIE_NIVEAU = {
  'bac-f3': [75], 'bac-d': [71], 'bac-c': [70], 'bac-c-e': [16], 'bac-h': [78], 'bac-g2': [77],
  'bep-electrotechnique': [15], 'bep-informatique': [59],
  'bts-electrotechnique': [98], 'bts-mai': [105],
}
const SERIE_COL = {
  'F1-F2-F3-F4': [73, 74, 75], 'F1-F2-F3': [73, 74, 75], 'F2-F3': [74, 75],
  'D': [71], 'C-E': [16], 'G1-G2-H': [76, 77, 78],
}
// categorie / type_precis (tes ids)
const CAT = {
  'sujet': [1, 1], 'sujet-corrige': [1, 1], 'sujet-type': [1, 1], 'compilation': [1, 1],
  'corrige': [5, 2], 'cours': [2, 3], 'td': [4, 4], 'livre': [6, null],
}
const LABEL_TYPE = {
  'sujet': 'Sujet', 'corrige': 'Corrigé', 'sujet-corrige': 'Sujet et corrigé', 'sujet-type': 'Sujet type',
  'cours': 'Cours', 'td': 'TD', 'compilation': 'Compilation', 'livre': 'Livre',
}
const LABEL_NIVEAU = {
  'bac-f3': 'BAC F3', 'bac-d': 'BAC D', 'bac-c': 'BAC C', 'bac-c-e': 'BAC C-E', 'bac-h': 'BAC H', 'bac-g2': 'BAC G2',
  'bac-pro-electrotechnique': 'BAC Pro Électrotechnique', 'bac-sti-genie-electrotechnique': 'BAC STI Génie électrotechnique',
  'bep-electrotechnique': 'BEP Électrotechnique', 'bep-informatique': 'BEP Informatique',
  'cap-electrotechnique': 'CAP Électrotechnique', 'bts-electrotechnique': 'BTS Électrotechnique', 'bts-mai': 'BTS MAI',
  'superieur': 'Supérieur',
}
const LABEL_MATIERE = {
  'electrotechnique': 'Électrotechnique', 'mathematiques': 'Mathématiques', 'schema-automatisme': 'Schéma et automatisme',
  'electronique': 'Électronique', 'etude-equipement': 'Étude d\'équipement', 'mecanique-appliquee': 'Mécanique appliquée',
  'technologie': 'Technologie', 'dessin-technique': 'Dessin', 'techno-schema-automatisme': 'Technologie et schéma automatisme',
  'physique-appliquee': 'Physique appliquée', 'programmation': 'Programmation', 'etude-projet': 'Étude de projet',
  'svt': 'SVT', 'mesures-essais': 'Mesures et essais', 'comptabilite': 'Comptabilité',
  'mathematiques-financieres': 'Mathématiques financières', 'merise': 'Mérise',
  'technologie-informatique': 'Technologie informatique', 'droit': 'Droit', 'informatique-generale': 'Informatique générale',
  'philosophie': 'Philosophie', 'francais': 'Français', 'technologie-materiels': 'Technologie des matériels',
  'hygiene': 'Hygiène', 'physique-chimie': 'Physique-Chimie', 'anglais': 'Anglais', 'metallurgie': 'Métallurgie',
  'economie-organisation-entreprises': 'Économie et organisation des entreprises',
}
// ids deja connus dans ta table matieres (les autres sont retrouves par nom, sinon crees)
const MATIERE_ID = {
  'electrotechnique': 12, 'mathematiques': 10, 'svt': 16, 'philosophie': 14, 'francais': 11, 'anglais': 15,
  'physique-chimie': 13, 'dessin-technique': 20, 'merise': 34,
}

// ---------------------------------------------------------------- utilitaires
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function lireCsv(fichier) {
  let t = fs.readFileSync(fichier, 'utf8').replace(/^\uFEFF/, '')
  const lignes = []
  let champ = '', ligne = [], q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c === '"' && t[i + 1] === '"') { champ += '"'; i++ }
      else if (c === '"') q = false
      else champ += c
    } else if (c === '"') q = true
    else if (c === ';') { ligne.push(champ); champ = '' }
    else if (c === '\n') { ligne.push(champ.replace(/\r$/, '')); lignes.push(ligne); ligne = []; champ = '' }
    else champ += c
  }
  if (champ || ligne.length) { ligne.push(champ.replace(/\r$/, '')); lignes.push(ligne) }
  const [entete, ...corps] = lignes
  return corps.filter(l => l.length > 1).map(l => Object.fromEntries(entete.map((h, i) => [h.trim(), (l[i] || '').trim()])))
}

const ACCENTS = {
  electrique: 'électrique', electriques: 'électriques', electronique: 'électronique', electroniques: 'électroniques',
  electrotechnique: 'électrotechnique', electromagnetisme: 'électromagnétisme', thevenin: 'Thévenin', norton: 'Norton',
  generalites: 'généralités', schema: 'schéma', schemas: 'schémas', equipement: 'équipement', equipements: 'équipements',
  theoreme: 'théorème', theoremes: 'théorèmes', regime: 'régime', regimes: 'régimes', interets: 'intérêts',
  integrales: 'intégrales', integrale: 'intégrale', mathematique: 'mathématique', mathematiques: 'mathématiques',
  mecanique: 'mécanique', hygiene: 'hygiène', monophase: 'monophasé', triphase: 'triphasé', numerique: 'numérique',
  numeriques: 'numériques', serie: 'série', series: 'séries', unite: 'unité', reseau: 'réseau', reseaux: 'réseaux',
  protection: 'protection', corrige: 'corrigé', corriges: 'corrigés', probleme: 'problème', problemes: 'problèmes',
  energie: 'énergie', mesures: 'mesures', systeme: 'système', systemes: 'systèmes', logiques: 'logiques',
  fonction: 'fonction', derivee: 'dérivée', derivees: 'dérivées', equation: 'équation', equations: 'équations',
  etude: 'étude', 'ecole': 'école', 'evaluation': 'évaluation', 'controle': 'contrôle', 'devoir': 'devoir',
  puissance: 'puissance', 'regulation': 'régulation', 'generateur': 'générateur', 'generatrice': 'génératrice',
  'alternateur': 'alternateur', 'synchrone': 'synchrone', 'asynchrone': 'asynchrone', 'redresseur': 'redresseur',
  'ondulation': 'ondulation', 'electromecanique': 'électromécanique', 'idee': 'idée', 'resume': 'résumé',
  'theorie': 'théorie', 'definitions': 'définitions', 'methode': 'méthode', 'methodes': 'méthodes',
  'phenomene': 'phénomène', 'phenomenes': 'phénomènes', 'complexes': 'complexes', 'geometrie': 'géométrie',
  'trigonometrie': 'trigonométrie', 'statistiques': 'statistiques', 'probabilites': 'probabilités',
  'suites': 'suites', 'limites': 'limites', 'continuite': 'continuité', 'primitives': 'primitives',
  'transformateur': 'transformateur', 'transformation': 'transformation', 'diode': 'diode',
  'amplificateur': 'amplificateur', 'operationnel': 'opérationnel', 'operateurs': 'opérateurs',
  'differentiels': 'différentiels', 'physique': 'physique', 'caracteristiques': 'caractéristiques',
}
const NOMS_PROPRES = { baraka: 'Baraka', al: 'Al', karfo: 'Karfo', kabre: 'Kabré', topchrono: 'Topchrono', iteem: 'ITEEM' }
function humaniser(slug) {
  let m = slug.match(/^(1er|2e)-tour-([a-z])$/)
  if (m) return `${m[1]} tour (${m[2]})`
  const mots = slug.split('-').map(w => {
    if (/^(td|tp)\d*$/.test(w)) return w.toUpperCase()
    if (/^[a-z]\d+$/.test(w)) return w.toUpperCase()            // f3, c4...
    if (NOMS_PROPRES[w]) return NOMS_PROPRES[w]
    return ACCENTS[w] || w
  })
  const s = mots.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function titreDe(r) {
  const niv = LABEL_NIVEAU[r.niveau] || r.niveau
  const mat = LABEL_MATIERE[r.matiere] || ''
  const parties = [LABEL_TYPE[r.type] || r.type, niv]
  if (mat && !norm(niv).includes(norm(mat))) parties.push(mat)
  let t = parties.join(' ')
  if (r.annee) t += ' ' + r.annee
  const tour = { '1er': '1er tour', '2e': '2e tour', '1er+2e': '1er et 2e tour' }[r.tour]
  if (tour) t += ', ' + tour
  if (r.session === 'remplacement') t += ' (remplacement)'
  if (r.pays) t += ` (${r.pays})`
  if (r.titre) t += ' – ' + humaniser(r.titre)
  return t
}

function seriesDe(r) {
  if (r.serie && SERIE_COL[r.serie]) return SERIE_COL[r.serie]
  return SERIE_NIVEAU[r.niveau] || []
}

// ---------------------------------------------------------------- principal
async function main() {
  const lignes = lireCsv(MANIFESTE).filter(r => r.action === 'renommer' || r.action === 'convertir-docx')
  console.log(`Manifeste : ${lignes.length} documents a importer`)
  console.log(APPLIQUER ? 'MODE : APPLICATION (ecritures reelles)' : 'MODE : SIMULATION (aucune ecriture)')

  let db = null, supabase = null
  let matieresExistantes = []      // {id, nom}
  let titresExistants = new Set()

  if (!HORS_LIGNE) {
    require('dotenv').config({ path: path.join(__dirname, '.env.import') })
    const { Client } = require('pg')
    const { createClient } = require('@supabase/supabase-js')
    const { IMPORT_DATABASE_URL: dburl, IMPORT_SUPABASE_URL: surl, IMPORT_SUPABASE_SERVICE_KEY: skey } = process.env
    if (!dburl || !surl || !skey) throw new Error('Variables manquantes dans .env.import (IMPORT_DATABASE_URL, IMPORT_SUPABASE_URL, IMPORT_SUPABASE_SERVICE_KEY).')
    const refDb = (dburl.match(/\/\/postgres\.([a-z0-9]+):/) || [])[1]
    const refUrl = (surl.match(/\/\/([a-z0-9]+)\.supabase\.co/) || [])[1]
    if (!args.projet || args.projet === true) throw new Error('Ajoute --projet=REF (identifiant du projet Supabase vise).')
    if (!refDb || refDb !== refUrl || refDb !== args.projet) {
      throw new Error(`GARDE-FOU : projet different (base=${refDb}, storage=${refUrl}, --projet=${args.projet}). Rien n'a ete fait.`)
    }
    console.log(`Projet cible : ${refDb}`)
    db = new Client({ connectionString: dburl, ssl: { rejectUnauthorized: false } })
    await db.connect()
    supabase = createClient(surl, skey, { auth: { persistSession: false } })

    if (ANNULER) return await annuler(db, supabase)

    matieresExistantes = (await db.query('SELECT id, nom FROM matieres')).rows
    titresExistants = new Set((await db.query('SELECT titre FROM documents')).rows.map(r => norm(r.titre)))
    const n = (await db.query('SELECT COUNT(*)::int n FROM documents')).rows[0].n
    console.log(`Documents deja en base : ${n}`)

    // ---- verification des referentiels (ids ecrits en dur) : on s'arrete si la base cible ne correspond pas
    const manques = []
    const verifie = async (table, ids, libelle) => {
      const uniques = [...new Set(ids)].filter(Boolean)
      if (!uniques.length) return
      const { rows } = await db.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [uniques])
      const ok = new Set(rows.map(x => x.id))
      uniques.filter(i => !ok.has(i)).forEach(i => manques.push(`${libelle} id ${i}`))
    }
    await verifie('examens', Object.values(EXAMEN), 'examens')
    await verifie('categories', Object.values(CAT).map(c => c[0]), 'categories')
    await verifie('types_document', Object.values(CAT).map(c => c[1]), 'types_document')
    await verifie('series_filieres', [...Object.values(SERIE_NIVEAU), ...Object.values(SERIE_COL)].flat(), 'series_filieres')
    await verifie('matieres', Object.values(MATIERE_ID), 'matieres')
    if (manques.length) {
      throw new Error('Referentiels absents dans cette base :\n  - ' + manques.join('\n  - ') +
        '\nCharge d\'abord referentiels_seed.sql dans ce projet (ou verifie que c\'est le bon projet). Rien n\'a ete ecrit.')
    }
    console.log('Referentiels OK (examens, categories, types, series, matieres)')
  }

  const cacheMatiere = new Map()
  async function idMatiere(slug) {
    if (!slug) return null
    if (cacheMatiere.has(slug)) return cacheMatiere.get(slug)
    let id = MATIERE_ID[slug] || null
    const label = LABEL_MATIERE[slug] || slug
    if (!id) {
      const t = matieresExistantes.find(m => norm(m.nom) === norm(label))
      if (t) id = t.id
    }
    if (!id && APPLIQUER && db) {
      const { rows } = await db.query('INSERT INTO matieres (nom, domaine_id) VALUES ($1, NULL) RETURNING id', [label])
      id = rows[0].id
      matieresExistantes.push({ id, nom: label })
      console.log(`  + matiere creee : ${label} (id ${id})`)
    }
    cacheMatiere.set(slug, id || `A-CREER:${label}`)
    return cacheMatiere.get(slug)
  }

  const rapport = []
  const compte = {}
  const bump = k => { compte[k] = (compte[k] || 0) + 1 }
  let traites = 0

  for (const [i, r] of lignes.entries()) {
    if (traites >= LIMITE) break
    const titre = titreDe(r)
    const [categorie_id, type_precis_id] = CAT[r.type] || [null, null]
    const examen_id = examenDe(r.niveau)
    const niveau = niveauScolaire(r.niveau)
    const serieIds = seriesDe(r)
    const cle = PREFIXE + r.fichier_nouveau
    const chemin = path.join(DOSSIER, r.dossier_cible, r.fichier_nouveau)
    const ligneRapport = { id: r.id, titre, fichier: r.fichier_nouveau, categorie_id, type_precis_id, examen_id, series: serieIds.join('+'), matiere: r.matiere }
    const tag = `[${i + 1}/${lignes.length}]`

    if (!categorie_id || !examen_id) { bump('ERREUR-mapping'); rapport.push({ ...ligneRapport, resultat: 'ERREUR-mapping' }); console.log(tag, 'ERREUR mapping', r.fichier_nouveau); continue }
    if (!HORS_LIGNE && !fs.existsSync(chemin)) { bump('FICHIER-INTROUVABLE'); rapport.push({ ...ligneRapport, resultat: 'FICHIER-INTROUVABLE' }); console.log(tag, 'INTROUVABLE', chemin); continue }

    if (titresExistants.has(norm(titre))) { bump('titre-deja-en-base'); rapport.push({ ...ligneRapport, resultat: 'titre-deja-en-base' }); console.log(tag, 'deja en base (meme titre) :', titre); continue }

    if (!APPLIQUER) {
      const mid = await idMatiere(r.matiere)
      bump('a-importer'); rapport.push({ ...ligneRapport, matiere_id: mid, resultat: 'a-importer' })
      if (i < 8 || HORS_LIGNE && i % 40 === 0) console.log(tag, titre, `| cat ${categorie_id} type ${type_precis_id} examen ${examen_id} series [${serieIds}] matiere ${mid}`)
      traites++
      continue
    }

    // ---- application
    try {
      const { rows: ex } = await db.query('SELECT id FROM documents WHERE fichier_url = $1', [cle])
      if (ex[0]) { bump('deja-importe'); rapport.push({ ...ligneRapport, resultat: 'deja-importe' }); continue }

      const buf = fs.readFileSync(chemin)
      if (!buf.subarray(0, 1024).includes('%PDF-')) throw new Error('pas un PDF')
      const { error: eUp } = await supabase.storage.from(BUCKET).upload(cle, buf, { contentType: 'application/pdf', upsert: false })
      if (eUp && !/already exists|Duplicate/i.test(eUp.message)) throw new Error('Storage : ' + eUp.message)

      const mid = await idMatiere(r.matiere)
      try {
        await db.query('BEGIN')
        const { rows } = await db.query(
          `INSERT INTO documents (titre, description, fichier_url, niveau, annee_scolaire, admin_id, statut, actif, categorie_id, type_precis_id, examen_id)
           VALUES ($1,NULL,$2,$3,$4,$5,$6,0,$7,$8,$9) RETURNING id`,
          [titre, cle, niveau, r.annee || null, ADMIN_ID, STATUT, categorie_id, type_precis_id, examen_id])
        const docId = rows[0].id
        if (typeof mid === 'number') await db.query('INSERT INTO document_matieres (document_id, matiere_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [docId, mid])
        for (const s of serieIds) await db.query('INSERT INTO document_series (document_id, serie_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [docId, s])
        await db.query(
          `UPDATE documents d SET
             type_document = COALESCE(NULLIF(d.type_document, ''), (SELECT td.nom FROM types_document td WHERE td.id = d.type_precis_id)),
             cycle = COALESCE((SELECT e.nom FROM examens e WHERE e.id = d.examen_id), d.cycle),
             matiere = COALESCE((SELECT string_agg(m.nom, ', ' ORDER BY m.nom) FROM document_matieres dm JOIN matieres m ON m.id = dm.matiere_id WHERE dm.document_id = d.id), d.matiere)
           WHERE d.id = $1`, [docId])
        await db.query('COMMIT')
        titresExistants.add(norm(titre))
        bump('importe'); rapport.push({ ...ligneRapport, doc_id: docId, resultat: 'importe' })
        console.log(tag, 'OK', docId, titre, `(${(buf.length / 1048576).toFixed(1)} Mo)`)
      } catch (eDb) {
        await db.query('ROLLBACK').catch(() => {})
        await supabase.storage.from(BUCKET).remove([cle]).catch(() => {})
        throw eDb
      }
      traites++
    } catch (e) {
      bump('ERREUR'); rapport.push({ ...ligneRapport, resultat: 'ERREUR : ' + e.message })
      console.log(tag, 'ERREUR', r.fichier_nouveau, '-', e.message)
    }
  }

  const sortie = path.join(__dirname, APPLIQUER ? 'import_rapport.csv' : 'import_simulation.csv')
  const cols = ['id', 'titre', 'fichier', 'categorie_id', 'type_precis_id', 'examen_id', 'series', 'matiere', 'matiere_id', 'doc_id', 'resultat']
  fs.writeFileSync(sortie, '\uFEFF' + cols.join(';') + '\n' + rapport.map(l => cols.map(c => `"${String(l[c] ?? '').replace(/"/g, '""')}"`).join(';')).join('\n'))
  console.log('\nResume :')
  Object.entries(compte).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`))
  const aCreer = [...cacheMatiere.values()].filter(v => typeof v === 'string')
  if (aCreer.length) console.log('Matieres qui seront creees :', aCreer.map(v => v.replace('A-CREER:', '')).join(', '))
  console.log('Rapport :', sortie)
  if (db) await db.end()
}

async function annuler(db, supabase) {
  const { rows } = await db.query(`SELECT id, fichier_url FROM documents WHERE fichier_url LIKE $1`, [PREFIXE + '%'])
  console.log(`${rows.length} documents importes (fichier_url commence par ${PREFIXE}).`)
  if (!APPLIQUER) { console.log('Ajoute --appliquer pour les supprimer.'); await db.end(); return }
  const ids = rows.map(r => r.id)
  if (ids.length) {
    await db.query('BEGIN')
    await db.query('DELETE FROM commentaires WHERE document_id = ANY($1)', [ids]).catch(() => {})
    await db.query('DELETE FROM document_matieres WHERE document_id = ANY($1)', [ids])
    await db.query('DELETE FROM document_series WHERE document_id = ANY($1)', [ids])
    await db.query('DELETE FROM documents WHERE id = ANY($1)', [ids])
    await db.query('COMMIT')
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.storage.from(BUCKET).remove(rows.slice(i, i + 100).map(r => r.fichier_url))
      if (error) console.log('Storage :', error.message)
    }
  }
  console.log('Annulation terminee.')
  await db.end()
}

main().catch(e => { console.error('\nERREUR :', e.message); process.exit(1) })
