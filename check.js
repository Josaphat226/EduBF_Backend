const db = require('./database/database')

const admins = db.prepare('SELECT * FROM admins').all()
console.log('Admins dans la base :', admins)
