CREATE TABLE commentaires (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id),
  user_id INTEGER REFERENCES users(id),
  contenu TEXT NOT NULL,
  note INTEGER,
  visible INTEGER DEFAULT 0,
  date_publication TIMESTAMP DEFAULT now()
);