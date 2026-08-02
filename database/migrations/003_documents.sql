CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  titre VARCHAR(255) NOT NULL,
  description TEXT,
  fichier_url TEXT NOT NULL,
  niveau VARCHAR(50),
  cycle VARCHAR(50),
  serie_filiere VARCHAR(100),
  matiere VARCHAR(100),
  type_document VARCHAR(50),
  annee_scolaire VARCHAR(20),
  actif INTEGER DEFAULT 1,
  nb_telechargements INTEGER DEFAULT 0,
  admin_id INTEGER REFERENCES admins(id),
  date_upload TIMESTAMP DEFAULT now(),
  statut VARCHAR(20) DEFAULT 'publie'
);