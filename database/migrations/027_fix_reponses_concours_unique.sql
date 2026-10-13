-- Corrige le bug d'intégrité : une question ne peut être répondue
-- qu'une seule fois par session. Sans cette contrainte, un utilisateur
-- (ou une requête mal formée) pouvait soumettre plusieurs fois la même
-- question et gonfler son score artificiellement.

-- Avant d'ajouter la contrainte, on supprime les éventuels doublons
-- existants en ne gardant que la première réponse par question/session.
DELETE FROM concours.reponses_session
WHERE id NOT IN (
  SELECT MIN(id)
  FROM concours.reponses_session
  GROUP BY session_id, session_question_id
);

-- Maintenant on peut ajouter la contrainte sans risque d'erreur.
ALTER TABLE concours.reponses_session
ADD CONSTRAINT uq_reponse_session_question
UNIQUE (session_id, session_question_id);