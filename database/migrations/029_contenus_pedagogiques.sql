-- ============================================================================
-- 029 — Contenus pédagogiques originaux EduBF (exercices, devoirs, sujets)
-- ============================================================================
-- Schéma dédié "pedagogie", isolé de "public" (même principe que "concours") :
-- aucune table existante n'est modifiée.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS pedagogie;

-- ----------------------------------------------------------------------------
-- 1. Référentiel de programme : chapitres et notions
-- ----------------------------------------------------------------------------
CREATE TABLE pedagogie.chapitres (
  id SERIAL PRIMARY KEY,
  niveau_id INTEGER NOT NULL REFERENCES niveaux_scolaires(id) ON DELETE RESTRICT,
  matiere_id INTEGER NOT NULL REFERENCES matieres(id) ON DELETE RESTRICT,
  serie_id INTEGER REFERENCES series_filieres(id) ON DELETE RESTRICT, -- NULL = commun à toutes les séries
  titre VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL,
  description TEXT,
  ordre INTEGER NOT NULL DEFAULT 0,
  actif BOOLEAN NOT NULL DEFAULT true,
  date_creation TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_pedagogie_chapitres_slug
  ON pedagogie.chapitres (niveau_id, matiere_id, COALESCE(serie_id, 0), slug);
CREATE INDEX idx_pedagogie_chapitres_niveau_matiere
  ON pedagogie.chapitres (niveau_id, matiere_id, ordre);

CREATE TABLE pedagogie.notions (
  id SERIAL PRIMARY KEY,
  chapitre_id INTEGER NOT NULL REFERENCES pedagogie.chapitres(id) ON DELETE CASCADE,
  type VARCHAR(12) NOT NULL DEFAULT 'notion' CHECK (type IN ('notion', 'competence')),
  titre VARCHAR(200) NOT NULL,
  ordre INTEGER NOT NULL DEFAULT 0,
  actif BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_pedagogie_notions_chapitre ON pedagogie.notions (chapitre_id, ordre);

-- ----------------------------------------------------------------------------
-- 2. Identifiant court et permanent (QR code, référence imprimée sur les PDF)
-- ----------------------------------------------------------------------------
CREATE FUNCTION pedagogie.generer_code() RETURNS VARCHAR AS $$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  essai VARCHAR;
  i INTEGER;
BEGIN
  LOOP
    essai := '';
    FOR i IN 1..6 LOOP
      essai := essai || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM pedagogie.contenus WHERE code = essai);
  END LOOP;
  RETURN essai;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. Contenus (métadonnées)
-- ----------------------------------------------------------------------------
CREATE TABLE pedagogie.contenus (
  id SERIAL PRIMARY KEY,
  code VARCHAR(6) NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL CHECK (type IN
    ('exercice', 'serie_exercices', 'devoir', 'composition', 'sujet_examen')),
  titre VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,

  -- Classement (système éducatif burkinabè)
  niveau_id INTEGER NOT NULL REFERENCES niveaux_scolaires(id),
  matiere_id INTEGER NOT NULL REFERENCES matieres(id),
  examen_id INTEGER REFERENCES examens(id),
  session_id INTEGER REFERENCES sessions_examen(id),
  annee_scolaire VARCHAR(20),
  langue_id INTEGER REFERENCES langues(id),
  difficulte VARCHAR(10) CHECK (difficulte IN ('facile', 'moyen', 'difficile')),

  -- Copie de lecture, recopiée depuis le JSON de la version publiée
  duree_minutes INTEGER CHECK (duree_minutes > 0),
  bareme_total NUMERIC(6,2) CHECK (bareme_total > 0),

  -- Origine et droits
  origine VARCHAR(10) NOT NULL DEFAULT 'edubf' CHECK (origine IN ('edubf', 'externe')),
  source_nom TEXT,
  source_url TEXT,
  licence VARCHAR(100),
  autorisation VARCHAR(15) NOT NULL DEFAULT 'sans_objet'
    CHECK (autorisation IN ('sans_objet', 'a_verifier', 'obtenue', 'domaine_public')),
  autorisation_note TEXT,

  -- Niveau d'accès (tout est 'libre' au lancement)
  acces_sujet VARCHAR(10) NOT NULL DEFAULT 'libre'
    CHECK (acces_sujet IN ('libre', 'connecte', 'premium')),
  acces_corrige VARCHAR(10) NOT NULL DEFAULT 'libre'
    CHECK (acces_corrige IN ('libre', 'connecte', 'premium')),

  -- Publication
  version_publiee_id INTEGER,
  actif BOOLEAN NOT NULL DEFAULT true,

  -- Lien optionnel avec le catalogue existant
  document_lie_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,

  -- Rôles
  cree_par INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  relu_par INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  publie_par INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  date_creation TIMESTAMP NOT NULL DEFAULT now(),
  date_modification TIMESTAMP NOT NULL DEFAULT now(),
  date_publication TIMESTAMP,

  -- Recherche plein texte
  recherche TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('french', coalesce(titre, '') || ' ' || coalesce(description, ''))
  ) STORED,

  CONSTRAINT ck_contenus_examen_requis
    CHECK (type <> 'sujet_examen' OR examen_id IS NOT NULL),
  CONSTRAINT ck_contenus_source_externe
    CHECK (origine = 'edubf' OR source_nom IS NOT NULL),
  CONSTRAINT ck_contenus_droits_publication
    CHECK (
      version_publiee_id IS NULL
      OR origine = 'edubf'
      OR autorisation IN ('obtenue', 'domaine_public')
    )
);

ALTER TABLE pedagogie.contenus
  ALTER COLUMN code SET DEFAULT pedagogie.generer_code();

CREATE INDEX idx_pedagogie_contenus_classement
  ON pedagogie.contenus (niveau_id, matiere_id) WHERE actif;
CREATE INDEX idx_pedagogie_contenus_examen
  ON pedagogie.contenus (examen_id) WHERE examen_id IS NOT NULL;
CREATE INDEX idx_pedagogie_contenus_publies
  ON pedagogie.contenus (date_publication DESC) WHERE actif AND version_publiee_id IS NOT NULL;
CREATE INDEX idx_pedagogie_contenus_recherche
  ON pedagogie.contenus USING GIN (recherche);

CREATE TABLE pedagogie.contenu_series (
  contenu_id INTEGER NOT NULL REFERENCES pedagogie.contenus(id) ON DELETE CASCADE,
  serie_id INTEGER NOT NULL REFERENCES series_filieres(id) ON DELETE CASCADE,
  PRIMARY KEY (contenu_id, serie_id)
);
CREATE INDEX idx_pedagogie_contenu_series_serie ON pedagogie.contenu_series (serie_id);

CREATE TABLE pedagogie.contenu_chapitres (
  contenu_id INTEGER NOT NULL REFERENCES pedagogie.contenus(id) ON DELETE CASCADE,
  chapitre_id INTEGER NOT NULL REFERENCES pedagogie.chapitres(id) ON DELETE RESTRICT,
  PRIMARY KEY (contenu_id, chapitre_id)
);
CREATE INDEX idx_pedagogie_contenu_chapitres_chapitre ON pedagogie.contenu_chapitres (chapitre_id);

CREATE TABLE pedagogie.contenu_notions (
  contenu_id INTEGER NOT NULL REFERENCES pedagogie.contenus(id) ON DELETE CASCADE,
  notion_id INTEGER NOT NULL REFERENCES pedagogie.notions(id) ON DELETE RESTRICT,
  PRIMARY KEY (contenu_id, notion_id)
);
CREATE INDEX idx_pedagogie_contenu_notions_notion ON pedagogie.contenu_notions (notion_id);

-- ----------------------------------------------------------------------------
-- 4. Versions (le sujet et son corrigé évoluent ensemble)
-- ----------------------------------------------------------------------------
CREATE TABLE pedagogie.versions (
  id SERIAL PRIMARY KEY,
  contenu_id INTEGER NOT NULL REFERENCES pedagogie.contenus(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL CHECK (numero >= 1),
  statut VARCHAR(10) NOT NULL DEFAULT 'brouillon'
    CHECK (statut IN ('brouillon', 'relue', 'publiee', 'archivee')),

  contenu_json JSONB NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  empreinte CHAR(64),

  note_modification TEXT,
  cree_par INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  date_creation TIMESTAMP NOT NULL DEFAULT now(),
  relue_par INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  date_relecture TIMESTAMP,
  publiee_par INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  date_publication TIMESTAMP,

  pdf_sujet_url TEXT,
  pdf_corrige_url TEXT,
  pdf_statut VARCHAR(10) NOT NULL DEFAULT 'aucun'
    CHECK (pdf_statut IN ('aucun', 'en_cours', 'pret', 'echec')),
  pdf_erreur TEXT,
  pdf_tentatives INTEGER NOT NULL DEFAULT 0,
  pdf_genere_le TIMESTAMP,

  UNIQUE (contenu_id, numero),
  UNIQUE (id, contenu_id),

  CONSTRAINT ck_versions_note_modification
    CHECK (numero = 1 OR note_modification IS NOT NULL),
  CONSTRAINT ck_versions_publication
    CHECK (statut NOT IN ('publiee', 'archivee') OR (date_publication IS NOT NULL AND empreinte IS NOT NULL))
);

CREATE UNIQUE INDEX uq_pedagogie_versions_en_travail
  ON pedagogie.versions (contenu_id) WHERE statut IN ('brouillon', 'relue');
CREATE UNIQUE INDEX uq_pedagogie_versions_publiee
  ON pedagogie.versions (contenu_id) WHERE statut = 'publiee';
CREATE INDEX idx_pedagogie_versions_pdf_a_traiter
  ON pedagogie.versions (pdf_statut) WHERE pdf_statut IN ('aucun', 'en_cours', 'echec') AND statut = 'publiee';

ALTER TABLE pedagogie.contenus
  ADD CONSTRAINT fk_contenus_version_publiee
  FOREIGN KEY (version_publiee_id, id)
  REFERENCES pedagogie.versions (id, contenu_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Une version publiée ou archivée est figée
CREATE FUNCTION pedagogie.proteger_version() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.statut IN ('publiee', 'archivee') THEN
    IF NEW.contenu_json IS DISTINCT FROM OLD.contenu_json
       OR NEW.numero IS DISTINCT FROM OLD.numero
       OR NEW.contenu_id IS DISTINCT FROM OLD.contenu_id
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.empreinte IS DISTINCT FROM OLD.empreinte THEN
      RAISE EXCEPTION 'La version % est figée (statut %) : créer une nouvelle version.',
        OLD.numero, OLD.statut USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.statut IN ('brouillon', 'relue') THEN
      RAISE EXCEPTION 'Une version publiée ne peut pas redevenir brouillon.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pedagogie_versions_proteger
  BEFORE UPDATE ON pedagogie.versions
  FOR EACH ROW EXECUTE FUNCTION pedagogie.proteger_version();

CREATE FUNCTION pedagogie.interdire_suppression_version_figee() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.statut IN ('publiee', 'archivee') THEN
    RAISE EXCEPTION 'Impossible de supprimer la version % (statut %).', OLD.numero, OLD.statut
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pedagogie_versions_no_delete
  BEFORE DELETE ON pedagogie.versions
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION pedagogie.interdire_suppression_version_figee();

-- ----------------------------------------------------------------------------
-- 5. Événements (indicateurs du tableau de bord)
-- ----------------------------------------------------------------------------
CREATE TABLE pedagogie.evenements (
  id BIGSERIAL PRIMARY KEY,
  contenu_id INTEGER NOT NULL REFERENCES pedagogie.contenus(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES pedagogie.versions(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(25) NOT NULL CHECK (type IN
    ('vue_sujet', 'telechargement_sujet', 'vue_corrige', 'telechargement_corrige')),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_pedagogie_evenements_contenu ON pedagogie.evenements (contenu_id, type, created_at);
CREATE INDEX idx_pedagogie_evenements_date ON pedagogie.evenements (created_at);
CREATE INDEX idx_pedagogie_evenements_user ON pedagogie.evenements (user_id) WHERE user_id IS NOT NULL;