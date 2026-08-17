require('dotenv').config()
console.log('DATABASE_URL chargée :', !!process.env.DATABASE_URL)
console.log('PORT :', process.env.PORT)


const express = require('express')
const cors = require('cors')
const session = require('express-session')
const pgSession = require('connect-pg-simple')(session)
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const path = require('path')
const db = require('./database/database')

const passport = require('passport')
const GoogleStrategy = require('passport-google-oauth20').Strategy

const reco = require('./database/recommandation')

const app = express()
const PORT = process.env.PORT || 3000

const { envoyerEmailBienvenue } = require('./services/email')

// ========== SÉCURITÉ ==========

app.set('trust proxy', 1)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", process.env.SUPABASE_URL],
      frameSrc: ["'self'", process.env.SUPABASE_URL],
    },
  },
}))

// Autorise le frontend Next.js (dev et prod via env) à appeler
// l'API avec les cookies de session (withCredentials)
const allowedOrigins = (process.env.FRONTEND_URLS || 'http://localhost:3001')
  .split(',')
  .map(url => url.trim())

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true)
    else callback(new Error('Origine non autorisee par CORS: ' + origin))
  },
  credentials: true
}))

// Rate limiting global
const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Trop de requêtes. Réessaie dans 15 minutes.'
})
app.use(limiterGeneral)

// Rate limiting connexion — resserré uniquement sur le login
const limiterConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Trop de tentatives de connexion. Réessaie dans 15 minutes.'
})

// ========== CONFIGURATION ==========

app.use(express.urlencoded({ extended: true }))
app.use(express.json({
  // Conserve les octets bruts de chaque requête JSON, nécessaires pour
  // vérifier la signature HMAC des webhooks (SebPay signe le corps brut,
  // pas le JSON reparsé — les deux peuvent différer légèrement en
  // formatage, ce qui ferait échouer la vérification si on ne gardait
  // que la version reparsée).
  verify: (req, res, buf) => {
    req.rawBody = buf
  },
}))


const isProd = process.env.NODE_ENV === 'production'

app.use(session({
  store: new pgSession({
    pool: db,
    tableName: 'sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax'
  }
}))

// ========== PASSPORT GOOGLE ==========
app.use(passport.initialize())
app.use(passport.session())

passport.serializeUser((user, done) => done(null, user))
passport.deserializeUser((user, done) => done(null, user))

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.APP_URL + '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value
    const nom_complet = profile.displayName

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email])
    let user = rows[0]

 if (!user) {
      const { rows: newRows } = await db.query(
        'INSERT INTO users (nom_complet, email, mot_de_passe, email_verifie) VALUES ($1, $2, $3, 1) RETURNING *',
        [nom_complet, email, 'GOOGLE_AUTH_NO_PASSWORD']
      )
      user = newRows[0]
      envoyerEmailBienvenue(user.email, user.nom_complet)
    }

    if (user.statut === 'suspendu') {
      return done(null, false, { message: 'Compte suspendu.' })
    }

    return done(null, { id: user.id, nom_complet: user.nom_complet, email: user.email })
  } catch (err) {
    return done(err)
  }
}))

// ========== API JSON (frontend Next.js) ==========
app.use('/api', require('./routes/api'))
app.use('/api/admin', require('./routes/admin-api'))

// Erreurs sur les routes /api : toujours répondre en JSON, jamais en HTML
app.use('/api', (err, req, res, next) => {
  console.error(err.stack)
  res.status(err.status || 500).json({ error: err.message || 'Une erreur est survenue.' })
})

// ========== CONNEXION GOOGLE ==========
// Ce ne sont pas des routes EJS — c'est un vrai mécanisme d'authentification,
// utilisé par le bouton "Continuer avec Google" du frontend Next.js.
// Le frontend étant sur une autre origine, on redirige explicitement vers lui
// (au lieu de '/', qui n'existe plus du tout côté backend).

const FRONTEND_URL = allowedOrigins[0]

app.get('/auth/google', (req, res, next) => {
  const cible = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/'
  passport.authenticate('google', { scope: ['profile', 'email'], state: cible })(req, res, next)
})

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: allowedOrigins[0] + '/connexion?erreur=google' }),
  (req, res) => {
    req.session.user = {
      id: req.user.id,
      nom_complet: req.user.nom_complet,
      email: req.user.email
    }
    // "state" transporte le "next" à travers toute la redirection vers
    // Google et retour — on l'utilise pour revenir exactement là où
    // l'utilisateur était avant de cliquer sur "Continuer avec Google".
    const cible = typeof req.query.state === 'string' && req.query.state.startsWith('/') ? req.query.state : '/'
    req.session.save(() => {
      res.redirect(allowedOrigins[0] + cible)
    })
  }
)

app.get('/auth/google/deconnexion', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect(FRONTEND_URL)
    })
  })
})

// ========== TRACKING TEMPS DE LECTURE ==========
app.post('/api/tracker', async (req, res) => {
  try {
    if (!req.session.user) return res.json({ ok: false })
    const { document_id, duree } = req.body
    if (!document_id || !duree) return res.json({ ok: false })

    await reco.enregistrerAction(
      req.session.user.id,
      document_id,
      'lecture',
      parseInt(duree)
    )
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false })
  }
})

// ========== ERREURS ==========

// Route légère utilisée uniquement pour garder le serveur éveillé (voir UptimeRobot/cron-job.org)
app.get('/health', (req, res) => {
  res.status(200).send('OK')
})


app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable.' })
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Une erreur est survenue. Réessaie plus tard.' })
})

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`)
})