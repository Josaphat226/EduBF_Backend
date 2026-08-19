CREATE TABLE pays (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL UNIQUE,
  code_iso VARCHAR(2) NOT NULL UNIQUE
);

CREATE TABLE systemes_educatifs (
  id SERIAL PRIMARY KEY,
  pays_id INTEGER NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  nom VARCHAR(150) NOT NULL
);

CREATE TABLE examens (
  id SERIAL PRIMARY KEY,
  systeme_educatif_id INTEGER NOT NULL REFERENCES systemes_educatifs(id) ON DELETE CASCADE,
  nom VARCHAR(100) NOT NULL,
  type_formation VARCHAR(50), -- 'Général', 'Technique', 'Professionnel', NULL si non pertinent
  ordre INTEGER DEFAULT 0
);
CREATE INDEX idx_examens_systeme ON examens(systeme_educatif_id);

CREATE TABLE series_filieres (
  id SERIAL PRIMARY KEY,
  examen_id INTEGER NOT NULL REFERENCES examens(id) ON DELETE CASCADE,
  nom VARCHAR(100) NOT NULL,
  type VARCHAR(30), -- 'serie' | 'filiere' | 'specialite' — libelle d'affichage uniquement
  ordre INTEGER DEFAULT 0
);
CREATE INDEX idx_series_examen ON series_filieres(examen_id);

CREATE TABLE domaines (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE matieres (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(150) NOT NULL,
  domaine_id INTEGER REFERENCES domaines(id) ON DELETE SET NULL,
  UNIQUE(nom, domaine_id)
);

CREATE TABLE niveaux_scolaires (
  id SERIAL PRIMARY KEY,
  pays_id INTEGER REFERENCES pays(id) ON DELETE CASCADE, -- NULL = niveau générique multi-pays
  nom VARCHAR(100) NOT NULL,
  ordre INTEGER DEFAULT 0
);

CREATE TABLE niveaux_academiques (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(50) NOT NULL UNIQUE -- Licence, Master, Doctorat
);

CREATE TABLE sessions_examen (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(50) NOT NULL UNIQUE -- Normale, Remplacement
);

CREATE TABLE langues (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(50) NOT NULL UNIQUE,
  code VARCHAR(5) NOT NULL UNIQUE
);

CREATE TABLE publics_cibles (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(50) NOT NULL UNIQUE -- Débutant, Intermédiaire, Avancé, Tous niveaux, Professionnel
);

CREATE TABLE universites (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(200) NOT NULL,
  pays_id INTEGER REFERENCES pays(id) ON DELETE SET NULL
);

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  icone VARCHAR(20), -- emoji ou nom d'icone
  ordre INTEGER DEFAULT 0
);

-- Donnees de depart pour les 7 categories (administrable ensuite depuis l'admin)
INSERT INTO categories (nom, slug, icone, ordre) VALUES
  ('Sujets d''examen officiels', 'sujets-examen', '📄', 1),
  ('Cours', 'cours', '📚', 2),
  ('Exercices', 'exercices', '✏️', 3),
  ('TD & TP', 'td-tp', '📝', 4),
  ('Corrigés', 'corriges', '📖', 5),
  ('Livres & Manuels', 'livres-manuels', '📕', 6),
  ('Mémoires & Thèses', 'memoires-theses', '🎓', 7);