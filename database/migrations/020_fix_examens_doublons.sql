-- Réassigne tout document qui pointerait encore vers les anciens id (défensif)
UPDATE documents SET examen_id = 7  WHERE examen_id = 1;
UPDATE documents SET examen_id = 8  WHERE examen_id = 2;
UPDATE documents SET examen_id = 9  WHERE examen_id = 3;
UPDATE documents SET examen_id = 10 WHERE examen_id = 4;
UPDATE documents SET examen_id = 11 WHERE examen_id = 5;
UPDATE documents SET examen_id = 12 WHERE examen_id = 6;

-- Supprime les 6 doublons vides (CASCADE nettoie aussi d'éventuelles
-- series_filieres déjà accrochées à ces id par la tentative précédente de 019)
DELETE FROM examens WHERE id IN (1, 2, 3, 4, 5, 6);