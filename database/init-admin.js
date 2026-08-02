const db = require('./database')
const bcrypt = require('bcrypt')

const nom = 'Admin Principal'
const email = 'admin@edubf.bf'
const motDePasse = 'admin1234'

const hash = bcrypt.hashSync(motDePasse, 10)

const existing = db.prepare('SELECT * FROM admins WHERE email = ?').get(email)

if (!existing) {
  db.prepare('INSERT INTO admins (nom, email, mot_de_passe) VALUES (?, ?, ?)').run(nom, email, hash)
  console.log('Admin créé avec succès !')
  console.log('Email :', email)
  console.log('Mot de passe :', motDePasse)
} else {
  console.log('Admin existe déjà.')
}

