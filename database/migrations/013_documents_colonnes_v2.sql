ALTER TABLE documents
  ADD COLUMN categorie_id INTEGER REFERENCES categories(id),
  ADD COLUMN examen_id INTEGER REFERENCES examens(id),
  ADD COLUMN universite_id INTEGER REFERENCES universites(id),
  ADD COLUMN niveau_academique_id INTEGER REFERENCES niveaux_academiques(id),
  ADD COLUMN session_id INTEGER REFERENCES sessions_examen(id),
  ADD COLUMN langue_id INTEGER REFERENCES langues(id),
  ADD COLUMN auteur TEXT,
  ADD COLUMN document_lie_id INTEGER REFERENCES documents(id);

-- categorie_id sera rendue NOT NULL seulement APRES le backfill complet
-- (etape 3 de la migration) — ne pas le faire dans cette migration-ci.

CREATE INDEX idx_documents_categorie ON documents(categorie_id);
CREATE INDEX idx_documents_examen ON documents(examen_id);
CREATE INDEX idx_documents_lie ON documents(document_lie_id);