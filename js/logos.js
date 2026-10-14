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
  // Page de passeport crème légèrement inclinée, couverte de tampons
  return _tile(u, '#1f4b7a', '#0b1f33', `
    <g transform="translate(256 268) scale(1.1) rotate(-7) translate(-256 -268)">
      <rect x="92" y="86" width="328" height="368" rx="22" fill="#000" opacity=".25" transform="translate(6 10)"/>
      <rect x="92" y="86" width="328" height="368" rx="22" fill="#f7efdc"/>
      <rect x="92" y="86" width="328" height="368" rx="22" fill="none" stroke="#e3d5b5" stroke-width="3"/>
      <path d="M118 160h276M118 210h276M118 260h276M118 310h276M118 360h276M118 410h276" stroke="#eadfc4" stroke-width="2"/>
      <!-- tampon rond rouge -->
      <g transform="rotate(-14 196 190)" opacity=".92">
        <circle cx="196" cy="190" r="70" fill="none" stroke="#d63b3b" stroke-width="9"/>
        <circle cx="196" cy="190" r="54" fill="none" stroke="#d63b3b" stroke-width="3"/>
        <text x="196" y="203" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="38" fill="#d63b3b" letter-spacing="2">ATLAS</text>
        <path d="M196 140l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z" fill="#d63b3b"/>
        <path d="M166 226h60" stroke="#d63b3b" stroke-width="4"/>
      </g>
      <!-- tampon rectangulaire bleu-vert avec avion -->
      <g transform="rotate(9 318 300)" opacity=".9">
        <rect x="246" y="250" width="146" height="100" rx="12" fill="none" stroke="#11807a" stroke-width="8"/>
        <rect x="258" y="262" width="122" height="76" rx="6" fill="none" stroke="#11807a" stroke-width="2.5"/>
        <path d="M292 304l58-18c6-2 11 3 7 8l-16 10 8 22-7 3-15-17-18 8 1 9-6 2-6-14-14-4 2-6z" fill="#11807a"/>
        <text x="319" y="333" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="800" font-size="15" fill="#11807a" letter-spacing="1.5">DÉPART</text>
      </g>
      <!-- tampon ovale violet -->
      <g transform="rotate(-6 198 372)" opacity=".85">
        <ellipse cx="198" cy="372" rx="76" ry="42" fill="none" stroke="#6b46c1" stroke-width="6"/>
        <ellipse cx="198" cy="372" rx="64" ry="31" fill="none" stroke="#6b46c1" stroke-width="2" stroke-dasharray="5 5"/>
        <text x="198" y="381" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="24" fill="#6b46c1" letter-spacing="1">ARRIVÉE</text>
      </g>
      <!-- petit tampon triangle orange -->
      <g transform="rotate(12 352 148)" opacity=".85">
        <path d="M352 104l46 80h-92z" fill="none" stroke="#e07a1f" stroke-width="7" stroke-linejoin="round"/>
        <circle cx="352" cy="158" r="12" fill="#e07a1f"/>
      </g>
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
  return _tile(u, '#ffb15c', '#ef2d56', `
    <circle cx="380" cy="150" r="56" fill="#fff" opacity=".25"/>
    <path d="M70 400C150 330 200 360 250 300" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-dasharray="4 26" opacity=".85"/>
    <g transform="translate(300 220) rotate(-35)">
      <path d="M-120 0c0-12 10-18 22-18h150l70-56c8-6 20 0 18 10l-22 46h54c12 0 26 8 26 18s-14 18-26 18h-54l22 46c2 10-10 16-18 10l-70-56h-150c-12 0-22-6-22-18z" fill="#fff"/>
      <path d="M-100-18l-20-34c-3-6 2-12 8-10l40 44z" fill="#fff"/>
      <path d="M-100 18l-20 34c-3 6 2 12 8 10l40-44z" fill="#fff"/>
    </g>
    <path d="M0 440c120-30 250-20 512-70V512H0z" fill="#fff" opacity=".14"/>`);
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
function _stamp(u, code) {
  let h = 0; for (const c of code) h = (h * 31 + c.charCodeAt(0)) | 0;
  const ink = _INKS[Math.abs(h) % _INKS.length];
  const rot = (Math.abs(h) % 17) - 8;
  const name = _countryName(code).toUpperCase();
  const fs = name.length > 20 ? 15 : name.length > 14 ? 19 : name.length > 9 ? 23 : 27;
  return _tile(u, '#f7efdc', '#e9dcbc', `
    <path d="M0 140h512M0 250h512M0 360h512" stroke="#e2d3b0" stroke-width="2"/>
    <g transform="rotate(${rot} 256 256)" opacity=".93">
      <defs><path id="tp${u}" d="M138 256a118 118 0 0 1 236 0"/><path id="bp${u}" d="M108 256a148 148 0 0 0 296 0"/></defs>
      <circle cx="256" cy="256" r="178" fill="none" stroke="${ink}" stroke-width="12"/>
      <circle cx="256" cy="256" r="162" fill="none" stroke="${ink}" stroke-width="3"/>
      <circle cx="256" cy="256" r="100" fill="none" stroke="${ink}" stroke-width="5"/>
      <text font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="${fs}" fill="${ink}" letter-spacing="2"><textPath href="#tp${u}" startOffset="50%" text-anchor="middle">${_esc(name)}</textPath></text>
      <text font-family="Nunito,Arial,sans-serif" font-weight="800" font-size="19" fill="${ink}" letter-spacing="5"><textPath href="#bp${u}" startOffset="50%" text-anchor="middle">★ ATLAS ★</textPath></text>
      <text x="256" y="285" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-weight="900" font-size="88" fill="${ink}">${_esc(code)}</text>
    </g>`, { gloss: false });
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
