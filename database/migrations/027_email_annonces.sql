CREATE TABLE IF NOT EXISTS email_desabonnes (
  email VARCHAR(255) PRIMARY KEY,
  date_desabonnement TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_envois (
  campagne VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  date_envoi TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (campagne, email)
);