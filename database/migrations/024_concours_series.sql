CREATE TABLE concours.series (
  id SERIAL PRIMARY KEY,
  domaine_id INTEGER NOT NULL REFERENCES concours.domaines(id),
  titre VARCHAR(150) NOT NULL,
  description TEXT,
  difficulte VARCHAR(20), -- nullable
  nb_questions_cible INTEGER NOT NULL DEFAULT 20,
  statut VARCHAR(20) NOT NULL DEFAULT 'brouillon',
  -- 'brouillon' | 'incomplete' | 'complete' | 'publiee'
  date_creation TIMESTAMP DEFAULT NOW(),
  date_publication TIMESTAMP
);
CREATE INDEX idx_concours_series_domaine ON concours.series(domaine_id);
CREATE INDEX idx_concours_series_statut ON concours.series(statut);

-- La relation plusieurs-a-plusieurs validee : une question peut appartenir
-- a zero, une, ou plusieurs series, sans jamais etre dupliquee.
CREATE TABLE concours.serie_questions (
  serie_id INTEGER NOT NULL REFERENCES concours.series(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES concours.questions(id) ON DELETE CASCADE,
  ordre INTEGER DEFAULT 0,
  PRIMARY KEY (serie_id, question_id)
);
CREATE INDEX idx_concours_seriequestions_question ON concours.serie_questions(question_id);