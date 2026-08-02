CREATE TABLE favoris (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  document_id INTEGER REFERENCES documents(id),
  date_ajout TIMESTAMP DEFAULT now(),
  UNIQUE (user_id, document_id)
);