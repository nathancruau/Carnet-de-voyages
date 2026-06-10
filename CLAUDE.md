# Carnet de Voyages — Guide Claude

## Présentation

PWA de carnet de voyage (planification, journal, budget, carte). Stack : JS vanilla ES modules, Firebase Auth + Firestore (sync cloud), localStorage (cache local), Leaflet (cartes), service worker.

Pas de build tool. Les fichiers sont servis directement par le navigateur.

---

## Versioning — à faire à chaque release

Quatre endroits à synchroniser, toujours le même numéro N :

| Fichier | Ce qu'on change |
|---------|----------------|
| `index.html` | `style.css?v=N` et `app.js?v=N` |
| `sw.js` | `const SHELL_CACHE = 'cv-shell-N'` |
| `store.js` | `export const APP_VERSION = 'N'` |

Version actuelle : **120**

---

## Fichiers clés

```
index.html              HTML principal, version CSS/JS
style.css               Tous les styles (une seule feuille)
sw.js                   Service worker (cache shell + tuiles OSM)
manifest.json           PWA manifest

js/
  app.js                Point d'entrée, routeur écrans
  auth.js               Firebase Auth (Google Sign-In, Firestore sync)
  store.js              État local (localStorage 'carnet_voyages_v1'), helpers
  utils.js              notify(), showModal(), closeModal(), date helpers, date picker
  home.js               Écran d'accueil (liste voyages)
  mymap.js              Écran Ma Carte (carte globale + destinations)
  gpx.js                Parse/génère GPX, stockage local GPX
  notifications.js      Notifications départ (localStorage, DST-safe)
  share.js              Partage de voyage (liens d'invitation, observateurs)

  trip/
    trip.js             Écran voyage (tabs, topbar, stats)
    mapcal.js           Onglet Carte & Planning
    journal.js          Onglet Carnet
    budget.js           Onglet Budget
    tricount.js         Onglet Dépenses partagées
    packing.js          Onglet Bagages
    sortie.js           Onglet Sorties
```

---

## Architecture mobile (body-scroll)

### Principe
- **Desktop** : écrans `position:fixed; inset:0`, scroll interne dans des conteneurs.
- **Mobile (≤ 768px)** : écrans `position:relative; height:auto; min-height:100dvh`, le scroll est celui du body. Les barres Safari se cachent automatiquement.

### Classes CSS dynamiques sur `#screen-app`
| Classe | Quand | Effet |
|--------|-------|-------|
| `tab-map-active` | Desktop uniquement, onglet mapcal | Conserve le layout fixe pour Leaflet |
| `tab-fixed-active` | (même chose, même condition) | Idem |
| `mc-carte-mode` | Mobile, mapcal en mode Carte | Map en `position:absolute;inset:0` avec hauteur explicite |

### Sélecteur pour les overrides body-scroll (mobile)
```css
#screen-app.active:not(.tab-map-active):not(.tab-fixed-active) { ... }
```

### Cartes dans le body-scroll
Les maps Leaflet ont besoin d'un conteneur à hauteur définie. Pattern :
```css
/* conteneur */
.map-col { position: relative; height: <valeur explicite>; overflow: hidden; }
/* map */
#map { position: absolute !important; inset: 0 !important; height: 100% !important; }
```

### Modales et scroll iOS
`showModal()` dans `utils.js` verrouille le body avec `position:fixed; top:-Ypx` sur mobile pour empêcher le scroll de la page derrière la modale. `closeModal()` restaure la position. `.mbox` a aussi `overscroll-behavior:contain`.

---

## Store (store.js)

```js
getState()                    // tout l'état local
setState(patch)               // merge shallow
getTrips()                    // tableau de voyages
getTrip(tripId)               // un voyage (toujours relire, jamais cacher)
updateTrip(tripId, patch)     // merge dans le voyage + sauvegarde + sync Firestore
createTrip(data)              // crée un voyage complet avec valeurs par défaut
uid()                         // ID aléatoire court
getSettings()                 // { theme, language, … }
getEventTypes()               // types d'événement (visite, activité, nuit, …)
```

Clé localStorage : `carnet_voyages_v1`

---

## utils.js — fonctions exportées

```js
esc(s)                         // escape HTML (utiliser partout dans innerHTML)
notify(msg, icon?)             // toast 3 secondes
showModal(html, { onClose? })  // ouvre la modale + scroll lock mobile
closeModal()                   // ferme + restaure scroll
isoToDate(iso)                 // 'YYYY-MM-DD' → Date à midi (évite DST)
dateToIso(date)                // Date → 'YYYY-MM-DD'
fmtDate(iso)                   // '15 Jan 2025'
fmtDateShort(iso)              // '15 Jan'
generateDays(trip)             // génère les jours entre startDate et endDate
dpInit / dpClick / dpNav …     // widget date picker
tCol / tIc / trIc / trNm …    // couleurs et icônes types d'événement
typeBadge(type)                // badge HTML voyage/weekend/sortie
colorOptsHtml(sel, fn)         // palette de couleurs cliquables
```

---

## Variables CSS importantes

```css
--c     /* fond principal */
--c2    /* fond secondaire */
--c3    /* bordure / séparateur */
--c4    /* bordure plus forte */
--ink   /* texte principal */
--ink2  --ink3  --ink4   /* texte secondaire, tertiaire, désactivé */
--teal  /* couleur primaire (#0d9488) */
--tl    /* fond teal clair */
--td    /* texte sur teal clair */
--coral /* couleur d'alerte/suppression */
--crl   /* fond coral clair */
--fn    /* police sans-serif (Nunito) */
--sf    /* police serif (Lora) */
--sh    /* ombre légère */
--shl   /* ombre lourde */
--topbar-h  /* hauteur topbar (~88px) */
```

Dark mode : `[data-theme="dark"] { ... }`

---

## Patterns récurrents

### Délégation d'événements
```js
// Les clics sont capturés sur le conteneur parent, pas sur chaque bouton.
panel.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  switch (btn.dataset.action) { ... }
});

// Éviter les doubles bindings avec WeakMap
const _handlers = new WeakMap();
if (_handlers.has(el)) el.removeEventListener('click', _handlers.get(el));
const h = e => _handleClick(e, tripId);
_handlers.set(el, h);
el.addEventListener('click', h);
```

### Toujours relire le trip avant de modifier
```js
// Mauvais : utiliser le trip capturé au moment du render
// Bon :
const freshTrip = getTrip(tripId);
if (!freshTrip) { closeModal(); return; }
```

### IDs générés
```js
uid()          // ID court aléatoire
'd_' + uid()   // jour
'ex_' + uid()  // dépense
'je_' + uid()  // entrée journal
```

---

## Onglet Carnet (journal.js) — notes spécifiques

- **3 vues mobiles** : `carte` (map + activités), `activite` (liste seule), `timeline` (frise chronologique)
- La timeline sur mobile est en body-scroll : `#jn-tl-wrap`, `.tl-wrap`, `.tl-scroll` ont tous `height:auto; overflow:visible` via les overrides CSS du bloc body-scroll.
- `_openJournalItemPanel()` nécessite `.map-col` dans le DOM → ne fonctionne qu'en mode carte. En timeline, utiliser `_openValidateModal()` directement.
- `_journalView` : `'map'` | `'timeline'` (persisté en mémoire entre les re-renders)
- `_journalMobTab` : `'carte'` | `'activite'` | `'timeline'` (mobile uniquement)

---

## Service Worker

- `cv-shell-N` : cache des fichiers app (stale-while-revalidate)
- `cv-tiles-1` : cache des tuiles OSM (cache-first, permanent)
- SHELL_URLS liste tous les JS/CSS/icons à précacher
- Message `PRECACHE_TILES` → précache les tuiles d'une bbox

---

## Bugs corrigés (historique utile)

| Version | Problème | Solution |
|---------|----------|----------|
| v103 | Barre bleue en bas des cartes mobile | body-scroll + `position:absolute;inset:0` sur les maps |
| v105 | Destinations MyMap : rectangle/scroll interne | `display:block!important` sur toute la chaîne flex |
| v107 | FP drift dans les soldes tricount | `Math.round(bal*100)/100` dans `computeBalances` |
| v107 | Bug DST dans notifications | `setDate(d+1)` au lieu de `+86400000` |
| v108 | Timeline mobile : hauteur 0, boutons inaccessibles | Override CSS `flex:none; height:auto; overflow:visible` sur `#jn-tl-wrap`/`.tl-wrap`/`.tl-scroll` |
| v108 | Scroll chaining modal iOS | `position:fixed` body sur `showModal`, restauration sur `closeModal` |
| v109 | Zoom pinch hors carte | `touchstart`/`gesturestart` + `touchmove`/`gesturechange` preventDefault multi-touch hors `.leaflet-container` |
| v109 | Bouton fermer carte stats sous notch | `padding-top:max(20px,env(safe-area-inset-top))` sur `.stat-card.stat-fs` |
| v110 | Modal ajouter/modifier écrasée sur mobile | Sheet plein-écran sur `body` (`_showMobileEventSheet`) au lieu de `.mbox` dans `.ov` |
| v110 | Clic pin carte ouvre EDP sur mobile | `_openEDP` redirige vers `_openEditEventModal` sur tout mobile (pas juste jours-mode) |
| v112 | Champs Heure/Coût et nuits superposés dans sheet | Injected `<style>` dans `_showMobileEventSheet` force colonne unique |
| v112 | Zoom pinch toujours possible hors carte | `gesturestart/change/end` prévenés globalement (Leaflet utilise touchmove) + `e.scale` check |
| v112 | Photos timeline/live-feed en petites vignettes | Carrousel scroll-snap plein-largeur avec carte GPX stats en 1ère slide |
| v113 | Champs superposés encore présents | HTML templates modifiés directement en `.fg` blocs empilés (pas d'injection CSS) |
| v114 | Import Polarsteps | `isPolarstepsExport` détecte `all_steps`, `importPolarstepsTrip` groupe par date, mappe météo → emoji |
| v115 | Stats catégories/compagnons + auto-save settings | `catExpenses`/`compMap` dans `_statsViewHtml` ; `change` délégué sur `.mbox` remplace le bouton Enregistrer |
| v116 | Import ZIP Polarsteps avec photos | `importPolarstepsZip` dans `import.js` (JSZip CDN, compression canvas, `journalData.validated=true` sur tous les PINs) |
| v117 | Menu ⋯ par voyage + export ZIP/PDF + import multi-format | `js/export.js` (nouveau) ; `importAnyZip` dans `import.js` ; modal export multi-sélection dans `home.js` |
| v118 | Types d'activités étendus (15 types) + UI paramètres simplifiée | `DEFAULT_EVENT_TYPES` étendu ; migration forward ; boutons Ajouter/Supprimer retirés des paramètres |
| v119 | Menu ⋯ : Modifier/Partager/Supprimer ; export PDF/Word personnalisé ; modal export corrigée | `_openTripMenu` étendu ; `_openPdfExportModal` + `exportTripCustom` avec thèmes/sections/couverture ; `.exp-trip-row` layout fix |
| v120 | Mode observateur amélioré | Carte observateur supprimée ; 2 onglets Carnet+Timeline ; carte de voyage en lecture seule ; stats excluent les observations ; notifications enrichies avec noms et événement ; supression commentaires/likes par propriétaires |
