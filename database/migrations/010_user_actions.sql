CREATE TABLE user_actions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  document_id INTEGER REFERENCES documents(id),
  action VARCHAR(20) NOT NULL,
  duree_secondes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);