// Colonnes de la table documents exposables publiquement.
// Volontairement absentes : fichier_url, admin_id, recherche_vecteur.
const COLONNES_DOCUMENT = [
  'id', 'titre', 'description', 'niveau', 'cycle', 'serie_filiere', 'matiere',
  'type_document', 'annee_scolaire', 'actif', 'nb_telechargements', 'date_upload',
  'statut', 'categorie_id', 'examen_id', 'universite_id', 'niveau_academique_id',
  'session_id', 'langue_id', 'auteur', 'document_lie_id', 'type_precis_id',
]

module.exports = {
  COLONNES_DOCUMENT: COLONNES_DOCUMENT.join(', '),
  COLONNES_DOCUMENT_D: COLONNES_DOCUMENT.map((c) => `d.${c}`).join(', '),
}