'use strict'
/**
 * MÉDIAS DES CONTENUS PÉDAGOGIQUES (schémas SVG, images)
 *
 * preparerMedia(buffer) contrôle un fichier envoyé par l'admin et renvoie ce qu'il
 * faut enregistrer dans le stockage :
 *   { buffer, contentType, extension, chemin, retires }
 *
 *  - Le type est déterminé par le CONTENU du fichier (signature), jamais par son nom
 *    ni par le type annoncé par le navigateur.
 *  - Formats acceptés : SVG, PNG, JPEG, WebP.
 *  - Un SVG est assaini : scripts, gestionnaires d'événements (onload…), foreignObject,
 *    animations, liens externes, imports CSS sont retirés. `retires` liste ce qui a été
 *    enlevé, pour en informer l'admin.
 *  - Le nom du fichier est l'empreinte SHA-256 du contenu final :
 *      contenus/<sha256>.<extension>
 *    Deux envois du même fichier donnent le même chemin ; le fichier ne change jamais,
 *    il peut donc être mis en cache indéfiniment. C'est ce chemin qui est stocké dans
 *    le document (figure.attrs.src) et il est vérifié par schema-v1.json.
 *
 * Les SVG sont toujours affichés via une balise <img> : dans ce mode le navigateur
 * n'exécute aucun script et ne charge aucune ressource externe. L'assainissement est
 * une seconde protection, utile si quelqu'un ouvre le lien du fichier directement.
 */

const crypto = require('crypto')
const createDOMPurify = require('dompurify')
const { JSDOM } = require('jsdom')

const BUCKET_MEDIAS = 'contenus-medias'
const TAILLE_MAX_OCTETS = 2 * 1024 * 1024 // aussi imposée par multer
const TAILLE_MAX_SVG = 1024 * 1024

class ErreurMedia extends Error {}

// ---------------------------------------------------------------------------
// Détection du type par signature
// ---------------------------------------------------------------------------

function detecterRaster(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Assainissement des SVG
// ---------------------------------------------------------------------------

const fenetre = new JSDOM('').window
const purify = createDOMPurify(fenetre)
let retiresEnCours = []

const BRUIT = /^(body|html|head|#.*)$/i // éléments ajoutés par le parseur, sans intérêt pour l'admin
// Données propres aux logiciels de dessin (Inkscape, métadonnées RDF…) : retirées sans en informer l'admin
const SCORIES = /^(xmlns|inkscape:|sodipodi:|<(sodipodi:|inkscape:|rdf:|cc:|dc:))/i

// Retire du CSS tout ce qui charge une ressource externe ou exécute du code
function nettoyerCss(css) {
  return css
    .replace(/@import[^;]*;?/gi, () => { retiresEnCours.push('@import'); return '' })
    .replace(/url\(\s*(['"]?)(?!#|data:image\/(?:png|jpe?g|gif|webp))[^)]*\1\s*\)/gi, () => { retiresEnCours.push('url() externe'); return 'none' })
    .replace(/expression\s*\(|-moz-binding|behavior\s*:/gi, () => { retiresEnCours.push('css dangereux'); return '' })
}

purify.addHook('afterSanitizeAttributes', (noeud) => {
  if (!noeud.hasAttribute) return
  // Liens : seulement vers un élément du même fichier (#id) ou une image raster intégrée
  for (const nom of ['href', 'xlink:href']) {
    if (!noeud.hasAttribute(nom)) continue
    const valeur = noeud.getAttribute(nom).trim()
    if (!(valeur.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(valeur))) {
      noeud.removeAttribute(nom)
      retiresEnCours.push(`${nom} externe`)
    }
  }
  if (noeud.hasAttribute('style')) noeud.setAttribute('style', nettoyerCss(noeud.getAttribute('style')))
  if (String(noeud.tagName).toLowerCase() === 'style') noeud.textContent = nettoyerCss(noeud.textContent)
})

function assainirSvg(texte) {
  // Prologue XML, DOCTYPE et commentaires : retirés. Une déclaration d'entités est refusée.
  if (/<!ENTITY/i.test(texte)) throw new ErreurMedia('Ce SVG contient des déclarations d’entités XML, refusées par sécurité.')
  let svg = texte
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  if (/^<svg:svg[\s>]/i.test(svg)) {
    throw new ErreurMedia('Ce SVG utilise des préfixes « svg: » sur ses éléments. Réenregistrez-le au format « SVG simple ».')
  }
  if (!/^<svg[\s>]/i.test(svg)) throw new ErreurMedia('Ce fichier n’est pas un SVG valide (il doit commencer par <svg>).')

  // Le XML doit être bien formé (analyse stricte, sans résolution d'entités externes)
  const analyse = new fenetre.DOMParser().parseFromString(svg, 'image/svg+xml')
  if (analyse.getElementsByTagName('parsererror').length) {
    throw new ErreurMedia('Ce SVG est mal formé (XML invalide). Rouvrez-le dans votre outil de dessin et réenregistrez-le.')
  }
  if (/<\/?svg:[a-z]/i.test(svg)) {
    throw new ErreurMedia('Ce SVG utilise des préfixes « svg: » sur ses éléments. Réenregistrez-le au format « SVG simple ».')
  }

  // L'espace de noms est obligatoire pour qu'un SVG s'affiche comme image
  const ouverture = svg.match(/^<svg[^>]*>/i)[0]
  if (!/\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(ouverture)) {
    svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }

  retiresEnCours = []
  const propre = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // <use> est indispensable à de nombreux schémas (symboles réutilisés). Il reste sûr car le
    // crochet ci-dessus ne laisse subsister que des liens vers un élément du même fichier (#id).
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['foreignObject', 'animate', 'animateMotion', 'animateTransform', 'set', 'script', 'iframe', 'object', 'embed'],
    ALLOW_DATA_ATTR: false
  })
  // Ce que DOMPurify a retiré lui-même (éléments et attributs), sans le bruit du parseur
  for (const r of purify.removed) {
    if (r.attribute) retiresEnCours.push(r.attribute.name)
    else if (r.element && !BRUIT.test(r.element.nodeName)) retiresEnCours.push(`<${String(r.element.nodeName).toLowerCase()}>`)
  }
  const retires = [...new Set(retiresEnCours)].filter(x => !SCORIES.test(x))

  if (!propre || !/^<svg[\s>]/i.test(propre.trim())) {
    throw new ErreurMedia('Ce SVG est illisible ou mal formé (XML invalide).')
  }

  // Dimensions : sans viewBox, le schéma ne s'adapterait pas à la page.
  let resultat = propre.trim()
  const racine = resultat.match(/^<svg[^>]*>/i)[0]
  if (!/\sviewBox\s*=/i.test(racine)) {
    const l = racine.match(/\swidth\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i)
    const h = racine.match(/\sheight\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i)
    if (!l || !h) throw new ErreurMedia('Ce SVG n’a ni viewBox ni dimensions (width/height) : il ne pourrait pas être mis à l’échelle.')
    resultat = resultat.replace(/^<svg/i, `<svg viewBox="0 0 ${l[1]} ${h[1]}"`)
  }

  return { texte: resultat, retires }
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

function preparerMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ErreurMedia('Fichier vide.')
  if (buffer.length > TAILLE_MAX_OCTETS) throw new ErreurMedia('Fichier trop volumineux (2 Mo maximum).')

  let contenu, contentType, extension, retires = []

  const raster = detecterRaster(buffer)
  if (raster) {
    ;({ contentType, extension } = raster)
    contenu = buffer
  } else {
    // Pas une image binaire connue : on tente le SVG (texte)
    const debut = buffer.subarray(0, 16384).toString('utf8')
    if (!/<(?:svg:)?svg[\s>]/i.test(debut) || debut.includes('\u0000')) {
      throw new ErreurMedia('Format non accepté. Formats possibles : SVG, PNG, JPEG, WebP.')
    }
    const { texte, retires: r } = assainirSvg(buffer.toString('utf8'))
    contenu = Buffer.from(texte, 'utf8')
    if (contenu.length > TAILLE_MAX_SVG) throw new ErreurMedia('SVG trop volumineux (1 Mo maximum).')
    contentType = 'image/svg+xml'
    extension = 'svg'
    retires = r
  }

  const empreinte = crypto.createHash('sha256').update(contenu).digest('hex')
  return { buffer: contenu, contentType, extension, chemin: `contenus/${empreinte}.${extension}`, retires }
}

module.exports = { preparerMedia, ErreurMedia, BUCKET_MEDIAS }