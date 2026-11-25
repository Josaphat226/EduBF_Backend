CREATE TABLE IF NOT EXISTS visites (
  id BIGSERIAL PRIMARY KEY,
  visiteur_id VARCHAR(40) NOT NULL,
  session_id VARCHAR(40) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  chemin VARCHAR(300) NOT NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'direct',
  appareil VARCHAR(12) NOT NULL DEFAULT 'ordinateur',
  secondes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  vu_a TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visites_date ON visites (created_at);
CREATE INDEX IF NOT EXISTS idx_visites_visiteur ON visites (visiteur_id, created_at);
CREATE INDEX IF NOT EXISTS idx_visites_session ON visites (session_id);
CREATE INDEX IF NOT EXISTS idx_visites_user ON visites (user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visites_chemin ON visites (chemin);

CREATE TABLE IF NOT EXISTS recherches (
  id BIGSERIAL PRIMARY KEY,
  terme VARCHAR(100) NOT NULL,
  origine VARCHAR(12) NOT NULL CHECK (origine IN ('documents', 'exercices')),
  nb_resultats INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recherches_date ON recherches (created_at);