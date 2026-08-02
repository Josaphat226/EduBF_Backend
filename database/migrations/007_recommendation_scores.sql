CREATE TABLE recommendation_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  document_id INTEGER REFERENCES documents(id),
  score DOUBLE PRECISION DEFAULT 0,
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE (user_id, document_id)
);