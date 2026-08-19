CREATE TABLE document_pays (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pays_id INTEGER NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, pays_id)
);

CREATE TABLE document_series (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  serie_id INTEGER NOT NULL REFERENCES series_filieres(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, serie_id)
);

CREATE TABLE document_matieres (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  matiere_id INTEGER NOT NULL REFERENCES matieres(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, matiere_id)
);

CREATE TABLE document_niveaux (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  niveau_id INTEGER NOT NULL REFERENCES niveaux_scolaires(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, niveau_id)
);

CREATE INDEX idx_docpays_pays ON document_pays(pays_id);
CREATE INDEX idx_docseries_serie ON document_series(serie_id);
CREATE INDEX idx_docmatieres_matiere ON document_matieres(matiere_id);
CREATE INDEX idx_docniveaux_niveau ON document_niveaux(niveau_id);