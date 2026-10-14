/* ============================================================
   ATLAS — Logos de l'appli (v248)
   ============================================================
   Chaque logo est une icône d'appli complète (carré arrondi + motif),
   en SVG vectoriel : nette à toutes les tailles (écran de démarrage,
   en-tête de l'accueil, paramètres).

   Logos pour tous : passeport (logo Atlas, = icône de l'écran d'accueil),
   globe, sextant, étoile polaire, avion, rose des vents.
   Logos à débloquer : un tampon par pays visité (« stamp:FR »…).

   logoSvg(id, size?)        → balise <svg> (identifiants internes uniques)
   availableLogos(trips)     → [{ id, name, locked? }] pour le choix dans les Paramètres
   visitedCountryCodes(trips)→ Set des codes pays des PINs des voyages
   setAppLogo(id) / currentLogoId() / appLogoHtml(cls)
   Le SVG du logo choisi est aussi gardé dans localStorage (`atlas_logo_svg`)
   pour que l'écran de démarrage (index.html) l'affiche avant tout JS.
   ============================================================ */

const LS_SVG = 'atlas_logo_svg';
const LS_ID  = 'atlas_logo_id';
let _seq = 0;

const _esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Fond d'icône : carré arrondi façon iOS, dégradé + léger reflet en haut
function _tile(u, c1, c2, body, { gloss = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg${u}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
    <clipPath id="cl${u}"><rect width="512" height="512" rx="114"/></clipPath>
    <radialGradient id="gl${u}" cx="0.3" cy="0" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <g clip-path="url(#cl${u})">
    <rect width="512" height="512" fill="url(#bg${u})"/>
    ${body}
    ${gloss ? `<rect width="512" height="512" fill="url(#gl${u})"/>` : ''}
  </g>
</svg>`;
}

// ── Logos ─────────────────────────────────────────────────────────────────────

function _passport(u) {
  // Page de passeport ouverte, bien droite (couture à gauche), deux tampons nets :
  // un grand rond « ATLAS » en haut, un visa rectangulaire avec avion en bas.
  const red = '#c8323a', teal = '#0f766e';
  return _tile(u, '#1d4e7e', '#0a1c30', `
    <defs><linearGradient id="pp${u}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ddcfab"/><stop offset=".08" stop-color="#f8f1df"/><stop offset="1" stop-color="#f3e9cf"/></linearGradient></defs>
    <rect x="72" y="60" width="368" height="392" rx="28" fill="#000" opacity=".3" transform="translate(4 12)"/>
    <rect x="72" y="60" width="368" height="392" rx="28" fill="url(#pp${u})"/>
    <g transform="rotate(-10 236 182)">
      <circle cx="236" cy="182" r="94" fill="none" stroke="${red}" stroke-width="13"/>
      <circle cx="236" cy="182" r="75" fill="none" stroke="${red}" stroke-width="4"/>
      <text x="236" y="200" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="44" fill="${red}" textLength="128" lengthAdjust="spacingAndGlyphs">ATLAS</text>
      <path d="M236 118l7 14 15 2-11 10 3 15-14-7-14 7 3-15-11-10 15-2z" fill="${red}"/>
      <path d="M196 224h80" stroke="${red}" stroke-width="6" stroke-linecap="round"/>
    </g>
    <g transform="rotate(6 284 356)">
      <rect x="180" y="302" width="208" height="108" rx="16" fill="none" stroke="${teal}" stroke-width="11"/>
      <rect x="195" y="317" width="178" height="78" rx="8" fill="none" stroke="${teal}" stroke-width="3"/>
      <path transform="translate(236 356) rotate(80) scale(.3) translate(-256 -256)" fill="${teal}" d="M256 128 C268 128 312 172 320 220 L388 256 C388 256 388 272 376 272 L320 260 L316 300 L340 316 C340 316 340 328 332 328 L280 308 L260 384 C260 384 248 388 244 384 L232 308 L180 328 C172 328 172 316 172 316 L196 300 L192 260 L136 272 C124 272 124 256 124 256 L192 220 C200 172 244 128 256 128Z"/>
      <text x="324" y="367" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="28" fill="${teal}" letter-spacing="2">VISA</text>
    </g>`);
}

function _globe(u) {
  return _tile(u, '#16b3a3', '#065f73', `
    <circle cx="256" cy="262" r="168" fill="#0b4f63" opacity=".35"/>
    <circle cx="256" cy="256" r="164" fill="#e9fbf8"/>
    <g fill="#5ccfb8">
      <path d="M170 150c30-18 70-20 92-6 14 9 6 26-10 30-22 6-30 22-22 40 6 14-10 26-26 18-20-10-32-6-44 6-14 14-34 2-30-18 4-26 18-56 40-70z"/>
      <path d="M300 200c22-6 50 4 64 26 10 16 2 34-16 36-18 2-24 18-18 34 8 22-10 44-34 42-22-2-28-24-22-44 6-18-4-30-14-44-10-14 8-44 40-50z"/>
      <path d="M200 330c18-4 34 8 34 24s-14 30-30 28-30-12-28-28 8-22 24-24z"/>
    </g>
    <g fill="none" stroke="#0b4f63" stroke-width="5" opacity=".55">
      <circle cx="256" cy="256" r="164"/>
      <ellipse cx="256" cy="256" rx="70" ry="164"/>
      <path d="M92 256h328M110 180h292M110 332h292"/>
    </g>
    <g transform="translate(330 150)">
      <path d="M0 52c-26-30-38-48-38-66a38 38 0 0 1 76 0c0 18-12 36-38 66z" fill="#ef2d56" stroke="#fff" stroke-width="7"/>
      <circle cx="0" cy="-14" r="13" fill="#fff"/>
    </g>`);
}

function _sextant(u) {
  // Sextant laiton sur fond vert océan profond
  const ticks = [];
  for (let a = 0; a <= 60; a += 5) {
    const r = (a - 30) * Math.PI / 180, r1 = 190, r2 = a % 10 ? 176 : 168;
    const x1 = 256 + Math.sin(r) * r1, y1 = 120 + Math.cos(r) * r1;
    const x2 = 256 + Math.sin(r) * r2, y2 = 120 + Math.cos(r) * r2;
    ticks.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`);
  }
  return _tile(u, '#0f5a52', '#062b2b', `
    <defs><linearGradient id="br${u}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe7a3"/><stop offset=".5" stop-color="#e2b04a"/><stop offset="1" stop-color="#a8741f"/></linearGradient></defs>
    <circle cx="256" cy="256" r="196" fill="none" stroke="#fff" stroke-opacity=".06" stroke-width="2"/>
    <g fill="none" stroke="url(#br${u})" stroke-linecap="round" stroke-linejoin="round">
      <path d="M256 120L161 284M256 120L351 284" stroke-width="16"/>
      <path d="M161 284A190 190 0 0 0 351 284" stroke-width="22"/>
      <path d="M200 216h112" stroke-width="10"/>
      <path d="M256 120L300 296" stroke-width="10"/>
    </g>
    <g stroke="#7a5414" stroke-width="3">${ticks.join('')}</g>
    <circle cx="256" cy="120" r="22" fill="url(#br${u})" stroke="#7a5414" stroke-width="4"/>
    <circle cx="256" cy="120" r="7" fill="#7a5414"/>
    <rect x="218" y="168" width="36" height="26" rx="5" fill="#bfe8f2" stroke="url(#br${u})" stroke-width="6"/>
    <rect x="300" y="196" width="70" height="20" rx="10" fill="url(#br${u})" transform="rotate(-28 335 206)"/>
    <path d="M182 330c0 30 30 50 74 50s74-20 74-50" fill="none" stroke="url(#br${u})" stroke-width="12" stroke-linecap="round"/>
    <circle cx="370" cy="118" r="5" fill="#fff"/><circle cx="398" cy="150" r="3" fill="#fff" opacity=".7"/><circle cx="130" cy="140" r="4" fill="#fff" opacity=".8"/>`);
}

function _polaris(u) {
  // Traînées d'étoiles autour du pôle + étoile polaire au centre
  const cx = 256, cy = 236;
  const arcs = [];
  const rand = (i, k) => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
  for (let i = 0; i < 16; i++) {
    const r = 26 + i * 15;
    const start = Math.abs(rand(i, 1)) * 360, len = 50 + Math.abs(rand(i, 2)) * 90;
    const a0 = start * Math.PI / 180, a1 = (start + len) * Math.PI / 180;
    const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r, x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
    const col = ['#ffffff', '#bfe3ff', '#ffe4b8', '#d9c8ff'][i % 4];
    arcs.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${col}" stroke-opacity="${(0.35 + Math.abs(rand(i, 3)) * 0.6).toFixed(2)}" stroke-width="${(2 + Math.abs(rand(i, 4)) * 3).toFixed(1)}"/>`);
  }
  return _tile(u, '#1b2a6b', '#05091f', `
    <defs><radialGradient id="pg${u}"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#cfe6ff" stop-opacity=".9"/><stop offset="1" stop-color="#cfe6ff" stop-opacity="0"/></radialGradient></defs>
    <g fill="none" stroke-linecap="round">${arcs.join('')}</g>
    <circle cx="${cx}" cy="${cy}" r="58" fill="url(#pg${u})"/>
    <path d="M${cx} ${cy - 44}L${cx + 9} ${cy - 9}L${cx + 44} ${cy}L${cx + 9} ${cy + 9}L${cx} ${cy + 44}L${cx - 9} ${cy + 9}L${cx - 44} ${cy}L${cx - 9} ${cy - 9}Z" fill="#fff"/>
    <path d="M0 470c90-40 170-44 256-30s170 10 256-24V512H0z" fill="#03050f"/>
    <path d="M60 470l26-40 22 26 20-50 30 64z" fill="#03050f"/>`, { gloss: false });
}

function _plane(u) {
  // Ancienne icône de l'appli (avion blanc sur sarcelle), reprise telle quelle
  return _tile(u, '#0d9488', '#0d9488', `
    <radialGradient id="pl${u}" cx="40%" cy="35%" r="60%"><stop offset="0%" stop-color="#14b8a6" stop-opacity=".6"/><stop offset="100%" stop-color="#0d9488" stop-opacity="0"/></radialGradient>
    <rect width="512" height="512" fill="url(#pl${u})"/>
    <path fill="#fff" opacity=".97" d="M256 128 C268 128 312 172 320 220 L388 256 C388 256 388 272 376 272 L320 260 L316 300 L340 316 C340 316 340 328 332 328 L280 308 L260 384 C260 384 248 388 244 384 L232 308 L180 328 C172 328 172 316 172 316 L196 300 L192 260 L136 272 C124 272 124 256 124 256 L192 220 C200 172 244 128 256 128Z"/>
    <g stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"><circle cx="256" cy="420" r="28" opacity=".4"/><path d="M256 396v8M256 436v8M232 420h8M272 420h8" opacity=".5"/></g>
    <circle cx="256" cy="420" r="4" fill="#fff" opacity=".5"/>`, { gloss: false });
}

function _compass(u) {
  const ticks = [];
  for (let a = 0; a < 360; a += 15) {
    const r = a * Math.PI / 180, l = a % 90 ? 10 : 22;
    ticks.push(`<path d="M${(256 + Math.sin(r) * 176).toFixed(1)} ${(256 - Math.cos(r) * 176).toFixed(1)}L${(256 + Math.sin(r) * (176 - l)).toFixed(1)} ${(256 - Math.cos(r) * (176 - l)).toFixed(1)}"/>`);
  }
  return _tile(u, '#f4ead3', '#d9c49a', `
    <circle cx="256" cy="256" r="190" fill="none" stroke="#8a6a35" stroke-width="6"/>
    <circle cx="256" cy="256" r="176" fill="none" stroke="#8a6a35" stroke-width="2"/>
    <g stroke="#8a6a35" stroke-width="4">${ticks.join('')}</g>
    <g transform="rotate(45 256 256)" opacity=".75">
      <path d="M256 120l18 136-18 136-18-136z" fill="#8a6a35"/>
      <path d="M120 256l136-18 136 18-136 18z" fill="#8a6a35"/>
    </g>
    <path d="M256 80l26 176h-52z" fill="#c8323a"/><path d="M256 432l26-176h-52z" fill="#23384f"/>
    <path d="M80 256l176-26v52z" fill="#23384f"/><path d="M432 256l-176-26v52z" fill="#23384f"/>
    <circle cx="256" cy="256" r="18" fill="#f4ead3" stroke="#8a6a35" stroke-width="6"/>
    <text x="256" y="66" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="40" fill="#c8323a">N</text>`, { gloss: false });
}

// Tampon d'un pays visité : encre de la couleur du pays (hachage), nom en arc
const _INKS = ['#c8323a', '#1f6fb2', '#11807a', '#6b46c1', '#b45309', '#be185d', '#2f6b2f', '#0e7490'];
let _regionNames = null;
function _countryName(code) {
  try { _regionNames ||= new Intl.DisplayNames(['fr'], { type: 'region' }); return _regionNames.of(code) || code; } catch (_) { return code; }
}
const _SHAPES = ['circle', 'rect', 'oval', 'octagon', 'scallop', 'hexagon'];
const _F = 'font-family="Nunito,Arial,sans-serif"';
function _poly(n, r, rot = 0, cx = 256, cy = 256) {
  return Array.from({ length: n }, (_, i) => {
    const a = (rot + i * 360 / n) * Math.PI / 180;
    return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');
}
// Texte droit (formes non rondes) : taille réduite pour tenir dans `w` px
const _fit = (txt, w, max) => Math.min(max, Math.floor(w / (txt.length * 0.68)));

function _stamp(u, code) {
  let h = 0; for (const c of code) h = (h * 31 + c.charCodeAt(0)) | 0;
  h = Math.abs(h);
  const ink = _INKS[h % _INKS.length];
  const shape = _SHAPES[(h >> 3) % _SHAPES.length];
  const rot = ((h >> 6) % 17) - 8;
  const name = _countryName(code).toUpperCase();
  const t = (x, y, fs, txt, extra = '') => `<text x="${x}" y="${y}" text-anchor="middle" ${_F} font-weight="900" font-size="${fs}" fill="${ink}" ${extra}>${_esc(txt)}</text>`;
  let body;
  if (shape === 'circle' || shape === 'scallop') {
    const fs = name.length > 20 ? 15 : name.length > 14 ? 19 : name.length > 9 ? 23 : 27;
    let edge;
    if (shape === 'circle') {
      edge = `<circle cx="256" cy="256" r="178" fill="none" stroke="${ink}" stroke-width="12"/><circle cx="256" cy="256" r="162" fill="none" stroke="${ink}" stroke-width="3"/>`;
    } else {
      // bord festonné (comme une dentelure de timbre)
      let d = '';
      const n = 28;
      for (let i = 0; i <= n; i++) {
        const a = i * 2 * Math.PI / n, r = 176;
        const x = 256 + Math.cos(a) * r, y = 256 + Math.sin(a) * r;
        if (!i) { d += `M${x.toFixed(1)} ${y.toFixed(1)}`; continue; }
        const am = (i - .5) * 2 * Math.PI / n;
        d += `Q${(256 + Math.cos(am) * 196).toFixed(1)} ${(256 + Math.sin(am) * 196).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      edge = `<path d="${d}Z" fill="none" stroke="${ink}" stroke-width="10" stroke-linejoin="round"/><circle cx="256" cy="256" r="158" fill="none" stroke="${ink}" stroke-width="3" stroke-dasharray="6 7"/>`;
    }
    body = `
      <defs><path id="tp${u}" d="M138 256a118 118 0 0 1 236 0"/><path id="bp${u}" d="M108 256a148 148 0 0 0 296 0"/></defs>
      ${edge}
      <circle cx="256" cy="256" r="100" fill="none" stroke="${ink}" stroke-width="5"/>
      <text ${_F} font-weight="900" font-size="${fs}" fill="${ink}" letter-spacing="2"><textPath href="#tp${u}" startOffset="50%" text-anchor="middle">${_esc(name)}</textPath></text>
      <text ${_F} font-weight="800" font-size="19" fill="${ink}" letter-spacing="5"><textPath href="#bp${u}" startOffset="50%" text-anchor="middle">★ ATLAS ★</textPath></text>
      ${t(256, 285, 88, code)}`;
  } else {
    let edge, w, top, mid, bot;
    if (shape === 'rect') {
      edge = `<rect x="76" y="132" width="360" height="248" rx="22" fill="none" stroke="${ink}" stroke-width="12"/><rect x="94" y="150" width="324" height="212" rx="12" fill="none" stroke="${ink}" stroke-width="3"/>
        <path d="M116 212h280M116 310h280" stroke="${ink}" stroke-width="3"/>`;
      w = 290; top = 194; mid = 293; bot = 344;
    } else if (shape === 'oval') {
      edge = `<ellipse cx="256" cy="256" rx="196" ry="138" fill="none" stroke="${ink}" stroke-width="11"/><ellipse cx="256" cy="256" rx="176" ry="120" fill="none" stroke="${ink}" stroke-width="3" stroke-dasharray="8 7"/>`;
      w = 250; top = 206; mid = 290; bot = 338;
    } else if (shape === 'octagon') {
      edge = `<polygon points="${_poly(8, 192, 22.5)}" fill="none" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/><polygon points="${_poly(8, 172, 22.5)}" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>`;
      w = 260; top = 196; mid = 290; bot = 346;
    } else { // hexagon
      edge = `<polygon points="${_poly(6, 196, 0)}" fill="none" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/><polygon points="${_poly(6, 176, 0)}" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>`;
      w = 250; top = 200; mid = 290; bot = 344;
    }
    body = `${edge}
      ${t(256, top, _fit(name, w, 36), name, 'letter-spacing="2"')}
      ${t(256, mid, shape === 'rect' ? 84 : 92, code)}
      ${t(256, bot, 20, '★ ATLAS ★', 'letter-spacing="5" font-weight="800"')}`;
  }
  return _tile(u, '#f7efdc', '#e9dcbc', `
    <path d="M0 140h512M0 250h512M0 360h512" stroke="#e2d3b0" stroke-width="2"/>
    <g transform="rotate(${rot} 256 256)" opacity=".93">${body}</g>`, { gloss: false });
}

const BASE = [
  { id: 'passport', name: 'Passeport', fn: _passport },
  { id: 'globe',    name: 'Globe',     fn: _globe },
  { id: 'sextant',  name: 'Sextant',   fn: _sextant },
  { id: 'polaris',  name: 'Étoile polaire', fn: _polaris },
  { id: 'plane',    name: 'Avion',     fn: _plane },
  { id: 'compass',  name: 'Rose des vents', fn: _compass },
];

export const DEFAULT_LOGO = 'passport';

export function logoSvg(id = DEFAULT_LOGO) {
  const u = 'L' + (++_seq);
  const m = /^stamp:([A-Z]{2})$/.exec(id || '');
  if (m) return _stamp(u, m[1]);
  return (BASE.find(b => b.id === id) || BASE[0]).fn(u);
}

/** Icône d'écran d'accueil (passeport) : carré plein (iOS arrondit lui-même) ;
 *  maskable = contenu réduit pour tenir dans la zone sûre d'Android. */
export function homeIconSvg({ maskable = false } = {}) {
  let svg = _passport('H').replace('rx="114"', 'rx="0"');
  if (maskable) svg = svg.replace(/(<rect width="512" height="512" fill="url\(#bgH\)"\/>)([\s\S]*?)(<rect width="512" height="512" fill="url\(#glH\)"\/>)/,
    (m, a, body, c) => `${a}<g transform="translate(256 256) scale(.8) translate(-256 -256)">${body}</g>${c}`);
  return svg;
}

/** Codes pays (ISO-2) des PINs de tous les voyages et sorties. */
export function visitedCountryCodes(trips) {
  const out = new Set();
  const add = c => { if (c && /^[A-Za-z]{2}$/.test(c)) out.add(c.toUpperCase()); };
  for (const t of trips || []) {
    add(t.pin?.countryCode);
    for (const d of t.days || []) for (const it of d.items || []) add(it.countryCode);
  }
  return out;
}

/** Logos proposés : les 6 pour tous, puis un tampon par pays visité (triés par nom). */
export function availableLogos(trips) {
  const stamps = [...visitedCountryCodes(trips)]
    .map(c => ({ id: `stamp:${c}`, name: _countryName(c), stamp: true }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return [...BASE.map(({ id, name }) => ({ id, name })), ...stamps];
}

export function currentLogoId() {
  try { return localStorage.getItem(LS_ID) || DEFAULT_LOGO; } catch (_) { return DEFAULT_LOGO; }
}

/** Choisit le logo : mémorisé (et son SVG, pour l'écran de démarrage) + mise à jour à l'écran. */
export function setAppLogo(id) {
  const svg = logoSvg(id);
  try { localStorage.setItem(LS_ID, id); localStorage.setItem(LS_SVG, svg); } catch (_) {}
  document.querySelectorAll('[data-app-logo]').forEach(el => { el.innerHTML = logoSvg(id); });
}

/** <span data-app-logo> rempli avec le logo courant (re-rempli par setAppLogo). */
export function appLogoHtml(cls = '') {
  return `<span class="app-logo ${cls}" data-app-logo aria-hidden="true">${logoSvg(currentLogoId())}</span>`;
}

/** Au démarrage / après la synchro : adopte le logo des paramètres (choisi sur un
 *  autre appareil) et garde le SVG mis en cache à jour (nouvelle version des dessins). */
export function syncLogoCache(preferred) {
  try {
    if (preferred && preferred !== currentLogoId() && (BASE.some(b => b.id === preferred) || /^stamp:[A-Z]{2}$/.test(preferred))) {
      setAppLogo(preferred); return;
    }
    const id = currentLogoId();
    const svg = logoSvg(id);
    if (localStorage.getItem(LS_SVG) !== svg) localStorage.setItem(LS_SVG, svg);
  } catch (_) {}
}
