CREATE TABLE IF NOT EXISTS campagnes_email (
  id SERIAL PRIMARY KEY,
  titre VARCHAR(150) NOT NULL,
  sujet VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  bouton_texte VARCHAR(60),
  bouton_lien VARCHAR(500),
  cible VARCHAR(20) NOT NULL DEFAULT 'utilisateurs'
    CHECK (cible IN ('utilisateurs', 'newsletter', 'tous')),
  statut VARCHAR(20) NOT NULL DEFAULT 'brouillon'
    CHECK (statut IN ('brouillon', 'en_cours', 'en_pause', 'terminee', 'annulee')),
  total_destinataires INTEGER,
  nb_envoyes INTEGER NOT NULL DEFAULT 0,
  nb_echecs INTEGER NOT NULL DEFAULT 0,
  admin_id INTEGER,
  date_creation TIMESTAMP DEFAULT NOW(),
  date_lancement TIMESTAMP,
  date_fin TIMESTAMP
);
ALTER TABLE campagnes_email ADD COLUMN IF NOT EXISTS derniere_erreur TEXT;