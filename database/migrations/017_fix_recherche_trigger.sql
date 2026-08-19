CREATE OR REPLACE FUNCTION maj_recherche_vecteur() RETURNS trigger AS $$
DECLARE
  texte_matieres TEXT;
  texte_examen TEXT;
  texte_universite TEXT;
BEGIN
  SELECT string_agg(m.nom, ' ') INTO texte_matieres
    FROM document_matieres dm JOIN matieres m ON m.id = dm.matiere_id
    WHERE dm.document_id = NEW.id;

  SELECT e.nom INTO texte_examen FROM examens e WHERE e.id = NEW.examen_id;
  SELECT u.nom INTO texte_universite FROM universites u WHERE u.id = NEW.universite_id;

  NEW.recherche_vecteur := to_tsvector('french',
    coalesce(NEW.titre, '') || ' ' ||
    coalesce(NEW.description, '') || ' ' ||
    coalesce(texte_matieres, '') || ' ' ||
    coalesce(texte_examen, '') || ' ' ||
    coalesce(texte_universite, '') || ' ' ||
    coalesce(NEW.annee_scolaire::text, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;