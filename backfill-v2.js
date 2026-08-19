/**
 * BACKFILL EduBF V2 — remplit les nouvelles tables a partir des documents
 * existants (colonnes cycle/serie_filiere/matiere/type_document).
 *
 * A lancer UNE SEULE FOIS, apres les migrations 012 a 016.
 * Usage : node backfill-v2.js
 */

require('dotenv').config()
const db = require('./database/database')

async function main() {
  console.log('=== Backfill EduBF V2 ===\n')

  // ---------- 1. Pays + systeme educatif ----------
  const { rows: paysRows } = await db.query(
    `INSERT INTO pays (nom, code_iso) VALUES ('Burkina Faso', 'BF')
     ON CONFLICT (nom) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`
  )
  const paysId = paysRows[0].id

  const { rows: systemeRows } = await db.query(
    `INSERT INTO systemes_educatifs (pays_id, nom)
     SELECT $1, 'Système éducatif du Burkina Faso'
     WHERE NOT EXISTS (SELECT 1 FROM systemes_educatifs WHERE pays_id = $1)
     RETURNING id`,
    [paysId]
  )
  const systemeId = systemeRows[0]
    ? systemeRows[0].id
    : (await db.query('SELECT id FROM systemes_educatifs WHERE pays_id = $1', [paysId])).rows[0].id

  console.log(`✓ Pays/système : Burkina Faso (id=${paysId})\n`)

  // ---------- 2. Examens (a partir de "cycle") ----------
  const { rows: cycles } = await db.query(
    `SELECT DISTINCT cycle FROM documents WHERE cycle IS NOT NULL AND cycle != ''`
  )
  const examenIdParNom = {}
  for (const { cycle } of cycles) {
    const { rows } = await db.query(
      `INSERT INTO examens (systeme_educatif_id, nom)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [systemeId, cycle]
    )
    const id = rows[0]
      ? rows[0].id
      : (await db.query(
          'SELECT id FROM examens WHERE systeme_educatif_id = $1 AND nom = $2',
          [systemeId, cycle]
        )).rows[0].id
    examenIdParNom[cycle] = id
    console.log(`✓ Examen : ${cycle} (id=${id})`)
  }
  console.log()

  // ---------- 3. Series/filieres (a partir de "serie_filiere", rattachees a leur examen) ----------
  const { rows: series } = await db.query(
    `SELECT DISTINCT cycle, serie_filiere FROM documents
     WHERE serie_filiere IS NOT NULL AND serie_filiere != ''`
  )
  const serieIdParCycleEtNom = {}
  for (const { cycle, serie_filiere } of series) {
    const examenId = examenIdParNom[cycle]
    if (!examenId) continue
    const { rows } = await db.query(
      `INSERT INTO series_filieres (examen_id, nom)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [examenId, serie_filiere]
    )
    const id = rows[0]
      ? rows[0].id
      : (await db.query(
          'SELECT id FROM series_filieres WHERE examen_id = $1 AND nom = $2',
          [examenId, serie_filiere]
        )).rows[0].id
    serieIdParCycleEtNom[`${cycle}::${serie_filiere}`] = id
    console.log(`✓ Série : ${cycle} / ${serie_filiere} (id=${id})`)
  }
  console.log()

  // ---------- 4. Matieres ----------
  const { rows: matieres } = await db.query(
    `SELECT DISTINCT matiere FROM documents WHERE matiere IS NOT NULL AND matiere != ''`
  )
  const matiereIdParNom = {}
  for (const { matiere } of matieres) {
    const { rows } = await db.query(
      `INSERT INTO matieres (nom) VALUES ($1)
       ON CONFLICT (nom, domaine_id) DO NOTHING
       RETURNING id`,
      [matiere]
    )
    const id = rows[0]
      ? rows[0].id
      : (await db.query('SELECT id FROM matieres WHERE nom = $1 AND domaine_id IS NULL', [matiere])).rows[0].id
    matiereIdParNom[matiere] = id
    console.log(`✓ Matière : ${matiere} (id=${id})`)
  }
  console.log()

  // ---------- 5. Types precis (deja crees en migration 016) ----------
  const { rows: typesRows } = await db.query('SELECT id, nom, categorie_id FROM types_document')
  const typeParNom = {}
  for (const t of typesRows) typeParNom[t.nom] = t

  // ---------- 6. Backfill de chaque document ----------
  const { rows: documents } = await db.query(
    `SELECT id, cycle, serie_filiere, matiere, type_document FROM documents`
  )
  console.log(`\n${documents.length} document(s) à traiter.\n`)

  let ok = 0
  let sansType = 0

  for (const doc of documents) {
    const type = typeParNom[doc.type_document]
    if (!type) {
      console.log(`⚠ Document id=${doc.id} : type_document "${doc.type_document}" inconnu, categorie/type_precis non renseignes`)
      sansType++
    }

    const examenId = doc.cycle ? examenIdParNom[doc.cycle] : null

    await db.query(
      `UPDATE documents
       SET categorie_id = $1, type_precis_id = $2, examen_id = $3
       WHERE id = $4`,
      [type ? type.categorie_id : null, type ? type.id : null, examenId, doc.id]
    )

    // Liaison N-N : matiere
    if (doc.matiere && matiereIdParNom[doc.matiere]) {
      await db.query(
        `INSERT INTO document_matieres (document_id, matiere_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [doc.id, matiereIdParNom[doc.matiere]]
      )
    }

    // Liaison N-N : serie
    if (doc.serie_filiere) {
      const cleSerieId = serieIdParCycleEtNom[`${doc.cycle}::${doc.serie_filiere}`]
      if (cleSerieId) {
        await db.query(
          `INSERT INTO document_series (document_id, serie_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [doc.id, cleSerieId]
        )
      }
    }

    ok++
  }

  console.log('\n=== Résumé ===')
  console.log(`✓ Documents traités       : ${ok}`)
  console.log(`⚠ Sans type reconnu       : ${sansType}`)
  console.log(`  Examens créés           : ${Object.keys(examenIdParNom).length}`)
  console.log(`  Séries/filières créées  : ${Object.keys(serieIdParCycleEtNom).length}`)
  console.log(`  Matières créées         : ${Object.keys(matiereIdParNom).length}`)

  await db.end()
  process.exit(0)
}

main().catch(err => {
  console.error('Erreur inattendue :', err)
  process.exit(1)
})