-- La classe (niveau) d'un contenu devient facultative.
-- La matière reste obligatoire.
ALTER TABLE pedagogie.contenus ALTER COLUMN niveau_id DROP NOT NULL;