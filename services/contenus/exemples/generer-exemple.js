'use strict'
// Génère exemple-exercice-3e.json à côté de ce script.
// Lancer : node services/contenus/exemples/generer-exemple.js

const fs = require('fs')
const path = require('path')

const t = (text) => ({ type: 'text', text })
const fi = (latex) => ({ type: 'formuleInline', attrs: { latex } })
const fb = (latex) => ({ type: 'formuleBloc', attrs: { latex } })
const p = (...c) => ({ type: 'paragraph', content: c })
const doc = (...c) => ({ type: 'doc', content: c })
const cell = (txt, header) => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(t(txt))] })
const row = (cells, header) => ({ type: 'tableRow', content: cells.map(c => cell(c, header)) })

const notes = [['Awa', 8], ['Issa', 12], ['Mariam', 10], ['Souleymane', 14], ['Fatou', 11]]

const sujet = {
  version_schema: 1,
  entete: {
    consignes: doc(p(t('Toute réponse doit être justifiée. Le soin de la présentation sera pris en compte.'))),
    materiel: 'Calculatrice autorisée',
    duree_minutes: 45,
    bareme_total: 10
  },
  parties: [{
    id: 'part-0001',
    titre: 'Activités numériques',
    exercices: [
      {
        id: 'exo-0001',
        titre: 'Racines carrées',
        enonce: doc(p(t('On considère le nombre '), fi('A = \\sqrt{50} - \\sqrt{18} + \\sqrt{8}'), t('.'))),
        questions: [
          {
            id: 'qst-0001',
            enonce: doc(
              p(t('Écrire '), fi('A'), t(' sous la forme '), fi('a\\sqrt{2}'), t(', où '), fi('a'), t(' est un entier.')),
              { type: 'zoneReponse', attrs: { lignes: 3 } }
            ),
            points: 2,
            corrige: {
              reponse_attendue: doc(p(fi('A = 4\\sqrt{2}'))),
              methode: doc(p(t('On décompose chaque radical en faisant apparaître le plus grand carré parfait, puis on regroupe les termes en '), fi('\\sqrt{2}'), t('.'))),
              etapes: [
                { titre: 'Décomposer chaque radical', doc: doc(fb('\\sqrt{50} = \\sqrt{25 \\times 2} = 5\\sqrt{2}'), fb('\\sqrt{18} = \\sqrt{9 \\times 2} = 3\\sqrt{2}'), fb('\\sqrt{8} = \\sqrt{4 \\times 2} = 2\\sqrt{2}')) },
                { titre: 'Regrouper', doc: doc(fb('A = 5\\sqrt{2} - 3\\sqrt{2} + 2\\sqrt{2} = (5 - 3 + 2)\\sqrt{2} = 4\\sqrt{2}')) }
              ],
              bareme: [
                { critere: 'Décomposition correcte des trois radicaux', points: 1.5 },
                { critere: 'Regroupement et résultat', points: 0.5 }
              ]
            }
          },
          {
            id: 'qst-0002',
            enonce: doc(p(t('On donne '), fi('B = (\\sqrt{5} + 1)(\\sqrt{5} - 1)'), t(' et '), fi('C = (2\\sqrt{3})^2'), t('.'))),
            sous_questions: [
              {
                id: 'qst-0002a',
                enonce: doc(p(t('Calculer '), fi('B'), t('.'))),
                points: 1.5,
                corrige: {
                  reponse_attendue: doc(p(fi('B = 4'))),
                  etapes: [{ doc: doc(p(t('On reconnaît l’identité remarquable '), fi('(a+b)(a-b) = a^2 - b^2'), t(' :')), fb('B = (\\sqrt{5})^2 - 1^2 = 5 - 1 = 4')) }]
                }
              },
              {
                id: 'qst-0002b',
                enonce: doc(p(t('Calculer '), fi('C'), t('.'))),
                points: 1,
                verification: { mode: 'numerique', valeur: 12 },
                corrige: {
                  reponse_attendue: doc(p(fi('C = 12'))),
                  etapes: [{ doc: doc(fb('C = 2^2 \\times (\\sqrt{3})^2 = 4 \\times 3 = 12')) }]
                }
              }
            ]
          },
          {
            id: 'qst-0003',
            enonce: doc(p(t('Donner la valeur approchée de '), fi('A'), t(' à '), fi('0{,}1'), t(' près.'))),
            points: 1,
            verification: { mode: 'numerique', valeur: 5.7, tolerance: 0.05 },
            corrige: {
              reponse_attendue: doc(p(fi('A \\approx 5{,}7'))),
              etapes: [{ doc: doc(p(t('D’après la question 1, '), fi('A = 4\\sqrt{2} \\approx 4 \\times 1{,}414 \\approx 5{,}657'), t(', soit '), fi('5{,}7'), t(' à '), fi('0{,}1'), t(' près.'))) }]
            }
          }
        ]
      },
      {
        id: 'exo-0002',
        titre: 'Statistiques',
        annexes: [{
          id: 'ann-0001',
          titre: 'Notes de cinq élèves',
          doc: doc({
            type: 'table',
            content: [row(['Élève', 'Note sur 20'], true), ...notes.map(([n, v]) => row([n, String(v)], false))]
          })
        }],
        enonce: doc(
          p(t('Le tableau et le diagramme ci-dessous présentent les notes obtenues par cinq élèves à un devoir de mathématiques.')),
          {
            type: 'graphique',
            attrs: {
              graphique_type: 'barres',
              titre: 'Notes obtenues',
              axe_x: { label: 'Élèves', categories: notes.map(n => n[0]) },
              axe_y: { label: 'Note sur 20', min: 0, max: 20 },
              series: [{ nom: 'Note', valeurs: notes.map(n => n[1]) }]
            }
          }
        ),
        questions: [
          {
            id: 'qst-0004',
            enonce: doc(p(t('Calculer la moyenne de ces notes.'))),
            points: 1.5,
            verification: { mode: 'numerique', valeur: 11 },
            corrige: {
              reponse_attendue: doc(p(t('La moyenne est égale à '), fi('11'), t('.'))),
              etapes: [{ doc: doc(fb('\\frac{8 + 12 + 10 + 14 + 11}{5} = \\frac{55}{5} = 11')) }],
              bareme: [{ critere: 'Somme correcte des notes', points: 0.5 }, { critere: 'Division par l’effectif et résultat', points: 1 }]
            }
          },
          {
            id: 'qst-0005',
            enonce: doc(p(t('Déterminer la médiane de cette série de notes.'))),
            points: 1.5,
            verification: { mode: 'numerique', valeur: 11 },
            corrige: {
              reponse_attendue: doc(p(t('La médiane est '), fi('11'), t('.'))),
              methode: doc(p(t('On range les notes dans l’ordre croissant ; l’effectif étant impair, la médiane est la valeur centrale.'))),
              etapes: [{ doc: doc(fb('8 \\;;\\; 10 \\;;\\; \\mathbf{11} \\;;\\; 12 \\;;\\; 14')) }]
            }
          },
          {
            id: 'qst-0006',
            enonce: doc(p(t('Calculer l’étendue de cette série.'))),
            points: 1.5,
            verification: { mode: 'numerique', valeur: 6 },
            corrige: {
              reponse_attendue: doc(p(t('L’étendue est '), fi('6'), t('.'))),
              etapes: [{ doc: doc(fb('14 - 8 = 6')) }]
            }
          }
        ]
      }
    ]
  }]
}

const sortie = path.join(__dirname, 'exemple-exercice-3e.json')
fs.writeFileSync(sortie, JSON.stringify(sujet, null, 2) + '\n')
console.log('Exemple généré :', sortie)



// Variante avec un schéma : node services/contenus/exemples/generer-exemple.js contenus/<votre-fichier>.svg
if (process.argv[2]) {
  const avecFigure = JSON.parse(JSON.stringify(sujet))
  avecFigure.parties[0].exercices[0].enonce.content.push({
    type: 'figure',
    attrs: {
      src: process.argv[2],
      alt: 'Circuit série : une source de tension et une résistance de 100 ohms',
      legende: 'Figure 1 — circuit série',
      credit: 'Schéma EduBF (essai)'
    }
  })
  const sortieFigure = path.join(__dirname, 'exemple-avec-figure.json')
  fs.writeFileSync(sortieFigure, JSON.stringify(avecFigure, null, 2) + '\n')
  console.log('Exemple avec figure :', sortieFigure)
}