CREATE TABLE types_document (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL UNIQUE,
  categorie_id INTEGER NOT NULL REFERENCES categories(id)
);

INSERT INTO types_document (nom, categorie_id) VALUES
  ('Sujet officiel', (SELECT id FROM categories WHERE slug = 'sujets-examen')),
  ('Corrigé',        (SELECT id FROM categories WHERE slug = 'corriges')),
  ('Cours',          (SELECT id FROM categories WHERE slug = 'cours')),
  ('TD / TP',        (SELECT id FROM categories WHERE slug = 'td-tp')),
  ('Devoir',         (SELECT id FROM categories WHERE slug = 'exercices')),
  ('Composition',    (SELECT id FROM categories WHERE slug = 'exercices')),
  ('Résumé',         (SELECT id FROM categories WHERE slug = 'cours'));

ALTER TABLE documents ADD COLUMN type_precis_id INTEGER REFERENCES types_document(id);
CREATE INDEX idx_documents_type_precis ON documents(type_precis_id);