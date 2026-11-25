'use strict'

// "Physique-Chimie" -> "physique-chimie" ; "Série d'exercices" -> "serie-d-exercices"
// Sert aux adresses lisibles des filtres : /exercices?niveau=3e&matiere=mathematiques
function slugifier(texte) {
  return String(texte)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

module.exports = { slugifier }