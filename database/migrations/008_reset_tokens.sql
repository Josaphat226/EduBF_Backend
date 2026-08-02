CREATE TABLE reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  expire_le TIMESTAMP NOT NULL,
  utilise BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);