-- Schema dedie, isole de "public" — aucune table existante n'est touchee
CREATE SCHEMA IF NOT EXISTS concours;

CREATE TABLE concours.domaines (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL UNIQUE,
  icone VARCHAR(50),
  ordre INTEGER DEFAULT 0,
  actif BOOLEAN DEFAULT true
);

INSERT INTO concours.domaines (nom, ordre) VALUES
  ('Informatique', 1),
  ('Mathématiques', 2),
  ('Électronique', 3),
  ('Marketing & Management', 4),
  ('Logic Tests', 5),
  ('Culture Générale', 6),
  ('Programmation', 7),
  ('Santé & Médecine', 8),
  ('Sciences de l''Éducation', 9),
  ('Droit', 10),
  ('Économie', 11),
  ('Langue Française', 12),
  ('Histoire', 13),
  ('Anglais', 14),
  ('Chimie', 15),
  ('Géographie', 16),
  ('Biologie', 17),
  ('Physique', 18),
  ('Didactique', 19);

CREATE TABLE concours.questions (
  id SERIAL PRIMARY KEY,
  domaine_id INTEGER NOT NULL REFERENCES concours.domaines(id),
  type VARCHAR(20) NOT NULL DEFAULT 'qcm', -- 'qcm' | 'reponse_libre'
  enonce TEXT NOT NULL,
  difficulte VARCHAR(20), -- 'facile' | 'moyen' | 'difficile', nullable
  source TEXT,
  explication TEXT,
  reponse_texte TEXT, -- rempli seulement si type = 'reponse_libre'
  statut VARCHAR(20) NOT NULL DEFAULT 'brouillon',
  -- 'brouillon' | 'a_verifier' | 'reponse_manquante' | 'ambigue' | 'validee' | 'publiee' | 'rejetee'
  import_id INTEGER, -- FK ajoutee dans la prochaine migration (table imports pas encore creee)
  date_creation TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_concours_questions_domaine ON concours.questions(domaine_id);
CREATE INDEX idx_concours_questions_statut ON concours.questions(statut);

CREATE TABLE concours.propositions (
  id SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES concours.questions(id) ON DELETE CASCADE,
  texte TEXT NOT NULL,
  est_correcte BOOLEAN NOT NULL DEFAULT false,
  ordre INTEGER DEFAULT 0
);
CREATE INDEX idx_concours_propositions_question ON concours.propositions(question_id);