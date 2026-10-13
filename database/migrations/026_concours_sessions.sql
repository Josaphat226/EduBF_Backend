CREATE TABLE concours.sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  serie_id INTEGER REFERENCES concours.series(id), -- nullable si entrainement personnalise
  domaines_choisis JSONB, -- rempli seulement si entrainement personnalise
  nb_questions INTEGER NOT NULL,
  score INTEGER,
  statut VARCHAR(20) NOT NULL DEFAULT 'en_cours', -- 'en_cours' | 'terminee'
  date_debut TIMESTAMP DEFAULT NOW(),
  date_fin TIMESTAMP
);
CREATE INDEX idx_concours_sessions_user ON concours.sessions(user_id);

-- Le figement : une copie complete de chaque question au moment ou la
-- session demarre. La session ne relit plus jamais concours.questions
-- ensuite — c'est ce qui la rend insensible a toute modification
-- ulterieure de la banque.
CREATE TABLE concours.session_questions (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES concours.sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES concours.questions(id),
  ordre INTEGER NOT NULL,
  contenu_snapshot JSONB NOT NULL
  -- structure : { enonce, type, difficulte, explication,
  --               propositions: [{ id, texte, est_correcte }, ...] }
);
CREATE INDEX idx_concours_sessionquestions_session ON concours.session_questions(session_id);

CREATE TABLE concours.reponses_session (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES concours.sessions(id) ON DELETE CASCADE,
  session_question_id INTEGER NOT NULL REFERENCES concours.session_questions(id) ON DELETE CASCADE,
  proposition_choisie_id INTEGER, -- fait reference a un id DANS le snapshot, pas concours.propositions
  reponse_texte_donnee TEXT,
  correcte BOOLEAN NOT NULL,
  date_reponse TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_concours_reponses_session ON concours.reponses_session(session_id);