-- Table utilisée automatiquement par connect-pg-simple pour stocker les sessions.
CREATE TABLE sessions (
  sid VARCHAR PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP NOT NULL
);