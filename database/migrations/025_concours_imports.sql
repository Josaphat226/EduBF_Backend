CREATE TABLE concours.imports (
  id SERIAL PRIMARY KEY,
  nom_fichier VARCHAR(255) NOT NULL,
  format VARCHAR(10) NOT NULL, -- 'txt' | 'csv' | 'json'
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  date_import TIMESTAMP DEFAULT NOW(),
  nb_questions_importees INTEGER DEFAULT 0
);

-- La FK laissee en suspens dans 023 (la table imports n'existait pas encore)
ALTER TABLE concours.questions
  ADD CONSTRAINT fk_questions_import
  FOREIGN KEY (import_id) REFERENCES concours.imports(id);