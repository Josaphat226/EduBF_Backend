require('dotenv').config()
const db = require('./database/database')

async function main() {
  const { rows: tables } = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `)

  for (const { table_name } of tables) {
    console.log('\n===== TABLE:', table_name, '=====')

    const { rows: columns } = await db.query(`
      SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table_name])

    columns.forEach(c => {
      console.log(
        `  ${c.column_name} | ${c.data_type}${c.character_maximum_length ? '(' + c.character_maximum_length + ')' : ''} | nullable=${c.is_nullable} | default=${c.column_default || '-'}`
      )
    })

    const { rows: constraints } = await db.query(`
      SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = 'public' AND tc.table_name = $1
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `, [table_name])

    const grouped = {}
    constraints.forEach(c => {
      grouped[c.constraint_name] = grouped[c.constraint_name] || { type: c.constraint_type, columns: [] }
      grouped[c.constraint_name].columns.push(c.column_name)
    })

    const { rows: fks } = await db.query(`
      SELECT
        tc.constraint_name,
        ccu.table_name AS references_table,
        ccu.column_name AS references_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
    `, [table_name])

    console.log('  --- contraintes (regroupées) ---')
    Object.entries(grouped).forEach(([name, info]) => {
      const fk = fks.find(f => f.constraint_name === name)
      if (info.type === 'FOREIGN KEY' && fk) {
        console.log(`  ${info.type} (${name}): [${info.columns.join(', ')}] -> ${fk.references_table}.${fk.references_column}`)
      } else {
        console.log(`  ${info.type} (${name}): [${info.columns.join(', ')}]`)
      }
    })
  }

  process.exit(0)
}

main().catch(err => {
  console.error('Erreur :', err?.message || err)
  process.exit(1)
})