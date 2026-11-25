'use strict'
// Tests purs (aucune base de données ni stockage requis).
// Lancer : node --test tests/contenus-medias.test.js

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { preparerMedia, ErreurMedia } = require('../services/contenus/medias')

const svg = (interieur, attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"') => Buffer.from(`<svg ${attrs}>${interieur}</svg>`)
const refuse = (buf, morceau) => assert.throws(() => preparerMedia(buf), e => e instanceof ErreurMedia && e.message.includes(morceau))

const CIRCUIT = `<g fill="none" stroke="#000"><rect x="30" y="10" width="40" height="20"/><path d="M0 20H30M70 20H100"/></g><text x="50" y="45" text-anchor="middle">R</text>`

test('un SVG propre est accepté et stocké sous contenus/<sha256>.svg', () => {
  const r = preparerMedia(svg(CIRCUIT))
  assert.equal(r.contentType, 'image/svg+xml')
  assert.match(r.chemin, /^contenus\/[a-f0-9]{64}\.svg$/)
  assert.equal(r.chemin, `contenus/${crypto.createHash('sha256').update(r.buffer).digest('hex')}.svg`)
  assert.deepEqual(r.retires, [])
  assert.ok(r.buffer.toString().includes('<rect'))
})

test('le même fichier donne toujours le même chemin', () => {
  assert.equal(preparerMedia(svg(CIRCUIT)).chemin, preparerMedia(svg(CIRCUIT)).chemin)
})

test('script, gestionnaires d’événements et foreignObject sont retirés', () => {
  const r = preparerMedia(svg(`<script>alert(1)</script><rect width="5" height="5" onclick="alert(2)"/><foreignObject><div>x</div></foreignObject>`, 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(3)"'))
  const sortie = r.buffer.toString()
  assert.doesNotMatch(sortie, /script|onclick|onload|foreignobject|alert/i)
  assert.ok(r.retires.includes('<script>') && r.retires.includes('onclick') && r.retires.includes('onload'))
  assert.ok(sortie.includes('<rect'))
})

test('les liens externes sont retirés, les liens internes (#id) conservés', () => {
  const r = preparerMedia(svg(`<defs><symbol id="r"><rect width="5" height="5"/></symbol></defs><use xlink:href="#r"/><use xlink:href="http://evil.example/x.svg#a"/><image href="http://evil.example/p.png" width="3" height="3"/><a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a>`,
    'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"'))
  const sortie = r.buffer.toString()
  assert.ok(sortie.includes('xlink:href="#r"'))
  assert.doesNotMatch(sortie, /evil\.example|javascript:/)
})

test('le CSS qui charge une ressource externe est neutralisé', () => {
  const r = preparerMedia(svg(`<style>@import url(http://evil.example/x.css); .a{fill:url(http://evil.example/p)}</style><rect class="a" style="fill:url(http://evil.example/q)" width="5" height="5"/>`))
  assert.doesNotMatch(r.buffer.toString(), /evil\.example|@import/)
})

test('les animations SMIL (set, animate) sont retirées', () => {
  const r = preparerMedia(svg(`<a><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="x" to="5"/><rect width="5" height="5"/></a>`))
  assert.doesNotMatch(r.buffer.toString(), /<set|<animate|javascript/i)
})

test('un SVG Inkscape (prologue, DOCTYPE, métadonnées) est accepté sans bruit', () => {
  const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 297" inkscape:version="1.2">
<sodipodi:namedview id="base"/><g inkscape:label="Calque 1"><path d="M 20,20 H 100" style="fill:none;stroke:#000"/></g></svg>`
  const r = preparerMedia(Buffer.from(inkscape))
  assert.deepEqual(r.retires, [])
  assert.match(r.buffer.toString(), /viewBox="0 0 210 297"/)
  assert.doesNotMatch(r.buffer.toString(), /sodipodi|inkscape|DOCTYPE/)
})

test('un SVG sans espace de noms est corrigé ; sans viewBox, il est déduit de width/height', () => {
  const r1 = preparerMedia(Buffer.from('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'))
  assert.match(r1.buffer.toString(), /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  const r2 = preparerMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><rect width="5" height="5"/></svg>'))
  assert.match(r2.buffer.toString(), /viewBox="0 0 200 100"/)
})

test('refus : entités XML, XML mal formé, aucune dimension, préfixes svg:, HTML', () => {
  refuse(Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>&x;</text></svg>'), 'entités')
  refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5"</svg>'), 'mal formé')
  refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'), 'viewBox')
  refuse(Buffer.from('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><svg:rect width="1" height="1"/></svg:svg>'), 'préfixes')
  refuse(Buffer.from('<html><body><script>alert(1)</script></body></html>'), 'Format non accepté')
})

test('les images PNG, JPEG et WebP sont reconnues à leur signature', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)])
  assert.match(preparerMedia(png).chemin, /\.png$/)
  assert.match(preparerMedia(jpg).chemin, /\.jpg$/)
  assert.match(preparerMedia(webp).chemin, /\.webp$/)
})

test('le nom ou le type annoncé ne comptent pas : seul le contenu décide', () => {
  refuse(Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000'), 'Format non accepté')
  refuse(Buffer.from('bonjour'), 'Format non accepté')
  refuse(Buffer.alloc(0), 'vide')
})

test('un fichier trop volumineux est refusé', () => {
  refuse(Buffer.alloc(2 * 1024 * 1024 + 1, 1), 'trop volumineux')
})