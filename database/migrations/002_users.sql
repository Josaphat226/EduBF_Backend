CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  nom_complet VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  mot_de_passe TEXT NOT NULL,
  filiere_preferee VARCHAR(100),
  statut VARCHAR(20) DEFAULT 'actif',
  email_verifie INTEGER DEFAULT 1,
  date_inscription TIMESTAMP DEFAULT now(),
  classe VARCHAR(50),
  filiere VARCHAR(100)
);