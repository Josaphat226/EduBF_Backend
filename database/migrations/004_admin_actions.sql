CREATE TABLE admin_actions (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES admins(id),
  action VARCHAR(50) NOT NULL,
  cible VARCHAR(50) NOT NULL,
  cible_id INTEGER,
  details TEXT,
  date_action TIMESTAMP DEFAULT now()
);