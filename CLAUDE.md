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

Version actuelle : **174**

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
  photostore.js          Firebase Cloud Storage (upload photos, users/{uid}/photos/) — voir "Photos & sync" ci-dessous
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

- **Owner/membre desktop** : Carte et Timeline sont fusionnées en une seule vue (`.obs-tl-layout` > `.obs-tl-col` = timeline à gauche, `.map-col` = carte à droite), toujours visibles ensemble — plus de bouton de bascule.
- **Owner/membre mobile** : 2 onglets plein écran, `carte` ou `timeline` (`_journalMobTab`), rendus dans `#jn-mob-body`. Body-scroll : `#jn-mob-body`, `.tl-wrap`, `.tl-scroll` ont tous `height:auto; overflow:visible` via les overrides CSS du bloc body-scroll ; `#journal-map` garde une hauteur explicite (`calc(100dvh - 180px)`).
- **Observateur desktop** : même layout que owner/membre desktop (`_renderTimelineView`, carte + timeline côte à côte).
- **Observateur mobile** : mêmes 2 onglets plein écran que owner/membre mobile (`carte` / `timeline`, `_journalMobTab`, `#jn-mob-body`) — avant, un layout fixe côte-à-côte écrasait la carte à 260px de haut sur petit écran. `_renderObserverView` (ancien "feed" alternatif, jamais réellement atteignable depuis l'UI) a été supprimé.
- `_openJournalItemPanel()` nécessite `.map-col` dans le DOM (présent en permanence sur desktop ; sur mobile uniquement dans l'onglet Carte). En timeline, utiliser `_openValidateModal()` directement.

---

## Photos & sync cloud (photostore.js)

- Localement, les photos restent en base64 dans `localStorage` (`trip.photo`, `trip.photos[]`, `day.items[].photo/photos`, `journalData.photos[]`, `journalEntries[].photos[]`) — inchangé, pleine résolution.
- Pour la sync cloud (`users/{uid}` dans Firestore), `syncToFirestore` (auth.js) essaie d'abord d'**uploader chaque photo vers Firebase Storage** (`users/{uid}/photos/{id}.jpg`, via `uploadPhoto()`) et remplace le base64 par l'URL de téléchargement — le document Firestore ne contient alors plus que des URLs (quelques dizaines d'octets chacune), donc sa taille ne dépend plus du nombre de photos. Avant upload, `uploadPhoto()` redimensionne à 2000px/qualité 0.88 (photo originale d'un téléphone souvent 3000-4000px+, donc lente à charger telle quelle) et pose un `Cache-Control` immuable (chaque fichier a un id unique, jamais réécrit) ; un cache **persisté dans localStorage** (clé `carnet_photo_upload_cache`, indexé par un hash du contenu base64 — pas le contenu lui-même) évite de ré-uploader la même photo à chaque sync, y compris après un rechargement de l'app (voir v170 dans l'historique — un cache en mémoire seule se réinitialisait à chaque ouverture, créant un doublon Storage à chaque fois). `deletePhoto()` retire aussi l'entrée de cache correspondante pour qu'une photo re-ajoutée après suppression soit bien ré-uploadée plutôt que de pointer vers une URL morte.
- **Firebase Storage nécessite le plan payant Blaze** (carte bancaire sur le projet Firebase, même si l'usage réel reste sous les quotas gratuits inclus : 5 Go stockage + 1 Go/jour transfert). Si Storage n'est pas activé/joignable (`isPhotoStoreReady()` → false), `syncToFirestore` retombe sur l'ancien comportement : `compressTripsForFirestore` (utils.js) compresse et embarque les photos directement dans le document, avec paliers de compression adaptatifs et repli sur "sans photos" si même le palier le plus serré dépasse 1 Mo (voir v161 dans l'historique).
- Un upload de photo qui échoue (hors-ligne, rules Storage mal configurées, etc.) **n'est jamais supprimé silencieusement** de la copie cloud : `_buildCloudTrips` (auth.js) retombe photo par photo sur un embarquement compressé (comme avant Storage), et si même ça dépasse la limite pour tout le lot, sur `compressTripsForFirestore` en dernier recours. La photo reste de toute façon en base64 en local et sera réessayée en upload au prochain sync (cache dans `uploadPhoto`) — voir v165 dans l'historique (bug corrigé : un échec d'upload faisait disparaître la photo de la copie cloud, ce qui pouvait ensuite se propager en local via un autre appareil).
- Une photo (ou un voyage entier) supprimé est aussi **nettoyé côté Storage** : `syncToFirestore` compare l'ensemble des URLs Storage référencées par tous les voyages avant/après chaque écriture (`_collectStorageUrls`), et supprime (best-effort, `deletePhoto`) celles qui ont disparu — que ce soit une photo retirée d'un voyage ou un voyage supprimé en entier. Comparaison faite sur l'ensemble des voyages (pas voyage par voyage), donc une photo dupliquée dans deux voyages n'est jamais supprimée tant qu'au moins un des deux la référence encore.
- **Limites connues (scope volontairement réduit) :** le document `shared_trips/{tripId}` (partage, share.js) utilise toujours uniquement `compressTripsForFirestore` (pas de bascule vers Storage) — un voyage individuel très chargé en photos peut encore être limité. L'export ZIP (export.js) n'embarque que les photos encore en base64 localement ; une photo dont la source locale est déjà une URL Storage (reçue d'un autre appareil) est référencée mais pas ré-encodée dans le ZIP.

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
| v150 | Voyage supprimé qui réapparaît (tombstone manquant) | `state.deletedTrips` (id→deletedAt) persisté et synchronisé, vérifié dans `setState`/`replaceTripFromNetwork` — un snapshot tardif ne peut plus ressusciter un voyage supprimé |
| v150 | Édition sur un appareil non reflétée sur un autre | `syncToFirestore` garde la copie serveur si elle est plus récente qu'une copie locale obsolète, au lieu d'écraser aveuglément avec l'état local |
| v150 | `setDoc()` erreur "Unsupported field value: undefined" au 1er partage | `initSharedTripInFirestore` sanitize désormais via `JSON.parse(JSON.stringify(...))` comme les autres écritures Firestore |
| v150 | Sheet mobile ajout/édition événement glisse horizontalement | `overscroll-behavior:contain` + `overflow-x:hidden` sur `_showMobileEventSheet` |
| v150 | Photo non enregistrée à l'édition d'un voyage | `_openCropModal` utilise sa propre overlay (plus `showModal`/`closeModal` partagés) pour ne plus écraser/fermer la modale de création/édition en cours |
| v150 | Onglets Carte/Timeline du Carnet fusionnés (desktop) | `renderJournal` : timeline à gauche + carte à droite en permanence sur desktop (owner/membre) ; mobile garde 2 onglets Carte/Timeline (suppression de l'onglet Activité, redondant avec la Timeline) |
| v150 | Partage externe d'une étape du Carnet | `_shareJournalItem` (journal.js) : `navigator.share` (nom du voyage, jour, texte, météo, notes, montant, photos en `File`), fallback presse-papiers si Web Share indisponible. Bouton dans la modale de validation + sur chaque item validé de la timeline |
| v151 | Sync tel → cloud échouait tout le temps (jamais intermittent) | Le document personnel `users/{uid}` contient tous les voyages avec leurs photos en base64 non compressées → dépasse souvent la limite de 1 Mo de Firestore → `setDoc()` rejette systématiquement. `compressTripPhotos` (utils.js, partagé avec share.js) recompresse toutes les photos avant `syncToFirestore` |
| v151 | Photos de voyage qui clignotent / perdent en qualité | Sur une égalité de `updatedAt` (écho de notre propre écriture), le code remplaçait la copie locale (haute qualité) par la copie compressée venant de Firestore. Tie-breaking corrigé pour préférer la copie locale (`store.js` : `setState`, `replaceTripFromNetwork` ; `share.js` : `_loadAndListen`) + suppression d'un `renderHome()` redondant après `initSharedTrips()` dans `app.js` |
| v152 | Photos trop compressées après le fix v151 | Compression à 400px/55% (pensée pour un seul voyage partagé) appliquée telle quelle à la sync perso qui contient tous les voyages → qualité visiblement dégradée partout. `compressTripsForFirestore` (utils.js) essaie d'abord un palier qualité (900px/0.7) et n'escalade vers un palier agressif (450px/0.5) que si le payload dépasse ~900 Ko |
| v152 | Impossible de déplacer une activité vers un autre jour sur mobile | Le déplacement entre jours utilisait le drag-and-drop HTML5 (`dragstart`/`dragover`/`drop`), qui ne fonctionne pas au toucher. Ajout d'un sélecteur "Jour" dans la sheet mobile d'édition d'événement (`_openEditEventModal`, mapcal.js), qui réutilise `_moveEvent` (la même fonction que le drag-and-drop desktop) |
| v153 | Impossible de réordonner les activités dans un jour sur mobile | Même cause que le déplacement entre jours (drag-and-drop HTML5 inutilisable au toucher). Boutons ▲▼ ajoutés sur chaque `.evt-row` (mapcal.js), réutilisent `_reorderEvent` existant. `.evt-del`/`.evt-move` passent aussi en `opacity:1` sous 768px (le hover de survol ne marche pas au doigt) |
| v153 | Tri par date dans Ma Carte | La liste des voyages (panneau latéral + onglet mobile "Destinations") suivait l'ordre de stockage local. `_buildSidebarTree` (mymap.js) trie maintenant par date de fin (repli sur date de début), le plus récent en premier |
| v154 | Boutons ▲▼ trop petits / trop proches de supprimer | Agrandis sous 768px (32×30px min) + séparateur visuel (`border-left`) avant le bouton ✕ pour éviter les clics accidentels |
| v154 | Tracé du Carnet ne suivait que la 1ère nuit d'un séjour multi-nuits | `_jCollectWaypoints` (journal.js) n'avait pas la logique de continuité des nuits de mapcal.js. Ajout de `_jNightForDate` + injection d'un point de départ/retour de nuit à chaque jour couvert par le séjour, comme `_collectAllWaypoints` |
| v154 | Cliquer sur un jour du planning ne l'ouvrait pas parfois (PC+tel) | `_attachLeftPanelListeners` (mapcal.js) rattachait un nouveau jeu de listeners (click/drag) sur `#panel-mapcal` à chaque fois que l'onglet Carte & Planning était revisité, sans jamais retirer les précédents — un tap pouvait déclencher `_selectDay` un nombre pair de fois et s'annuler. Ajout d'un garde-fou (`WeakSet`) pour ne binder qu'une fois par panel |
| v154 | Catégorie sur deux lignes dans Budget (mobile) | `.exp-table` n'avait pas de version mobile ; le badge de catégorie s'enroulait dans une colonne trop étroite. Le tableau défile maintenant horizontalement (`overflow-x:auto`) et ses cellules passent en `white-space:nowrap` sous 768px |
| v154 | Modification d'une sortie potentiellement bloquée sur mobile | `_handleSortieSave` (home.js) faisait un appel réseau de géocodage inverse sans timeout à chaque enregistrement, même sans changement de lieu — sur une connexion mobile lente, "Enregistrer" pouvait sembler ne rien faire indéfiniment. Appel ignoré si le lieu n'a pas changé (édition), et limité à 6 s (`AbortController`) sinon |
| v155 | Régression v154 : tableau Budget cassé sur mobile | `display:block` sur `.exp-table` désynchronisait `thead`/`tbody` (plus de colonnes alignées). Retiré ; nouveau wrapper `.exp-table-wrap{overflow-x:auto}` autour des `<table>` (budget.js), et `white-space:nowrap` déplacé uniquement sur le badge catégorie (au lieu de toute la table) pour corriger le vrai bug v153 (catégorie sur deux lignes) sans rien casser d'autre |
| v155 | Modal Sortie pas adapté au mobile (affichage général, pas juste le géocodage) | Nouveau paramètre `fullscreenMobile` sur `showModal()` (utils.js), activé pour la modale Sortie (home.js) : classe CSS `mbox-fullscreen-mobile` donnant un vrai plein écran (`100dvh`, sans coins arrondis) au lieu du bottom-sheet `92dvh` habituel, pour laisser respirer son contenu dense (carte, GPX, photos, compagnons) |
| v156 | Carte invisible sur l'écran détail d'une sortie (mobile) | `sortie.js` n'est ni un onglet mapcal ni journal-timeline observateur → `#screen-app` ne reçoit jamais `tab-map-active`/`tab-fixed-active`, donc l'override body-scroll par défaut (`height:auto`) s'applique et écrase `.sortie-layout{height:100%}` (flex row), réduisant `.sortie-map-wrap` à une hauteur nulle. `@media(max-width:768px)` : `.sortie-layout` passe en colonne (info au-dessus, carte en dessous dans le flux), `.sortie-map-wrap` reçoit une hauteur explicite (260px) avec `#sortie-map` en `position:absolute;inset:0` (pattern carte body-scroll standard) |
| v157 | Statistiques : globe 3D à la place de la carte plate des pays visités | La carte du monde (canvas 2D équirectangulaire, colorée par intensité de visites) est remplacée par un globe orthographique rotatif (`_initGlobe`/`_drawGlobe` dans home.js) : pays visités coloriés par continent (gris sinon), petit badge rond avec drapeau sur chaque pays visité visible, rotation à la souris/au doigt (Pointer Events, `touch-action:none`). Sous le globe : nombre de pays visités + pourcentage du monde (~195), puis une grille de badges ronds "Drapeaux collectés" (un par pays visité) — cliquer un badge anime le globe vers ce pays (`_focusGlobeOnCountry`, interpolation d'angle avec gestion du passage ±180°) et affiche son nom. Réutilise les données déjà chargées pour l'ancienne carte (topojson `world-atlas` via CDN, `_ISO_N_A2`/`_A2_CONTINENT`/`_A2_NAME`/`_getVisitedMap`) |
| v158 | Globe des stats : sens de rotation inversé, drapeaux trop petits/pâles, pas de zoom | Le mapping drag→rotation avait le signe inversé sur les deux axes (`lambda`/`phi`), vérifié par calcul direct de la projection orthographique — corrigé pour que le globe suive le doigt/la souris. Les drapeaux dessinés au canvas (`ctx.fillText`) rendaient moins bien que les badges HTML ; remplacés par des `<button>` HTML réels positionnés en overlay absolu au-dessus du canvas (`_renderGlobeMarkers`, même rendu natif que les badges "Drapeaux collectés", cliquables directement sur le globe). Zoom ajouté : molette (desktop) + pincement à deux doigts (tactile, tracking multi-pointeurs), rayon du globe multiplié par `_globeZoom` (0.6×–3×) |
| v159 | Globe : zoom qui restait rond au lieu de se rapprocher, drapeaux = emoji dans un rond au lieu de vrais badges pleins ; onglet Dépenses qui débordait sur tel ; montant diffusé dans un partage externe ; carte voyage (accueil) affichait le budget prévu au lieu du dépensé | Globe : `.globe-stage` n'est plus découpé en cercle par CSS (seul le canvas dessine le cercle) — zoomer pousse maintenant l'horizon au-delà du cadre au lieu de juste agrandir un disque, zoom max 3×→6×. Drapeaux : `_flagImgHtml()` (home.js) affiche une vraie image de drapeau recadrée en cercle (`object-fit:cover`, flagcdn.com) par-dessus un emoji de repli si l'image ne charge pas (hors-ligne) — utilisé par les badges "Drapeaux collectés" et les marqueurs sur le globe. Dépenses/Tricount mobile : `.settlement-row` passe en `flex-wrap` (noms de participants longs), le donut de répartition par catégorie s'empile en colonne (`.tri-donut-row`) au lieu de forcer une largeur minimale, `overflow-x:hidden` en filet de sécurité sur `.tri-main`. Partage Carnet : `_shareJournalItem` (journal.js) n'inclut plus jamais le montant dans le texte partagé. Carte voyage (home.js) : la puce de stats affiche désormais le total `realExpenses` (dépensé) au lieu de `budgetLines` (prévu) |
| v160 | Globe : les marqueurs-drapeaux repassaient en emoji pendant le zoom/drag et grossissaient sans limite avec le zoom (cachaient toute la carte) | `_renderGlobeMarkers` (home.js) reconstruisait `innerHTML` à chaque frame → chaque `<img>` de drapeau était recréé et rechargée en boucle, interrompant son chargement (flash sur l'emoji de repli). Remplacé par une réconciliation par clé (`_globeMarkerEls` : Map code→élément, réutilisé entre les redraws, seuls `left/top/width/height` sont mis à jour) — les images ne se rechargent plus jamais après le premier affichage. Taille des marqueurs découplée du zoom (calculée sur le rayon de base, comme un pin de carte qui ne grossit pas avec le zoom) au lieu de suivre `_globeZoom` linéairement |
| v161 | Sync tel→cloud qui échoue de nouveau (bibliothèque bien remplie) + photos qui reclignotent | Root cause identique à v151 mais reproduite par la croissance des données : `compressTripsForFirestore` (utils.js) n'avait que 2 paliers fixes (900px/0.7, 450px/0.5) — un compte avec assez de photos dépasse encore la limite de 1 Mo même au palier serré, et `syncToFirestore` échoue alors *systématiquement* pour ce compte (plus jamais de sync confirmée → le tie-break sur `updatedAt` ne voit plus jamais de nouvelle donnée serveur fraîche, d'où le clignotement qui semble revenir). Ajout d'un 3ᵉ palier (250px/0.4) et surtout d'un filet de sécurité final : si même le palier le plus serré dépasse encore la limite, les photos sont retirées de la copie synchronisée (mais conservées en local) plutôt que de faire échouer tout l'envoi — le reste des données (dates, budget, journal, GPX…) atteint toujours le cloud |
| v162 | Sync limitée par le 1 Mo Firestore : la compression seule ne suffira plus avec plusieurs Go de photos | Changement d'architecture : nouveau module `photostore.js` (Firebase Cloud Storage). `syncToFirestore` (auth.js) essaie maintenant d'**uploader** chaque photo vers Storage (`users/{uid}/photos/{id}.jpg`) et de ne stocker que son URL dans Firestore, au lieu d'embarquer le base64 compressé — la taille du document ne dépend plus du tout du nombre/poids des photos. Repli automatique sur l'ancien comportement (`compressTripsForFirestore`) si Storage n'est pas joignable (hors-ligne, pas encore activé). Nécessite le plan Firebase Blaze (carte bancaire, usage réel gratuit sous les quotas inclus) — voir section "Photos & sync cloud" ci-dessus pour le détail et les limites connues (share.js/export ZIP pas encore migrés, pas de nettoyage auto des fichiers orphelins) |
| v163 | Globe : drag trop rapide une fois zoomé ; mode de transport impossible à changer sur certains déplacements ; pas de suggestion de compagnons déjà connus | Globe : la sensibilité du drag (deg/px) était fixe alors que le rayon affiché de la sphère grandit avec `_globeZoom` — divisée par `_globeZoom` pour garder un vrai effet 1:1 (le contenu suit le doigt) à tout niveau de zoom. Déplacements (mapcal.js) : `_collectAllWaypoints` lit `item.transport` en priorité pour les items de type `drive`, mais les deux sélecteurs de mode (onglet "Déplacements" + clic sur le tracé) n'écrivaient que dans `item.routeMode` — le changement était donc silencieusement ignoré au rendu suivant pour ces items ; les deux points d'écriture choisissent maintenant le bon champ selon `item.type`. Compagnons : nouvelle liste de suggestions (`_knownCompanions`, home.js) sous le champ d'ajout dans les modales voyage et sortie — propose les personnes déjà présentes sur d'autres voyages (triées par fréquence), un clic les ajoute directement |
| v164 | Mode de transport toujours bloqué pour les trajets vers/depuis une nuit ; suggestions de compagnons figées sur les plus fréquents | Même défaut de conception que le fix v163, mais pour les pins de nuit : `_collectAllWaypoints` codait `mode: 'car'` en dur pour les deux bords "nuit" (départ de la nuit précédente / retour à la nuit du soir), qui partagent le même `dayId` mais représentent deux arêtes distinctes du trajet — aucun champ éditable ne les distinguait. Ajout de `day.departNightMode`/`day.returnNightMode` (lus via de nouveaux flags `isDepartNight`/`isReturnNight` sur le waypoint), et les deux sélecteurs de mode écrivent maintenant dans le bon champ selon lequel des deux bords est cliqué. Suggestions de compagnons (`_compSuggestChipsHtml`, home.js) : passent d'une liste statique (top 8 par fréquence) à un filtre dynamique dès que l'utilisateur tape dans le champ — cherche alors dans tous les compagnons connus, pas seulement les plus fréquents |
| v165 | **Bug critique v162** : les photos disparaissaient (bannière/timeline), y compris des photos déjà présentes avant | `syncToFirestore` (auth.js) considérait Storage comme prêt dès que le SDK s'initialisait (`isPhotoStoreReady()`), sans vérifier que les uploads réussissaient réellement — si Storage n'était pas vraiment joignable (règles de sécurité par défaut bloquant tout accès, Blaze pas encore actif, etc.), **chaque upload échouait silencieusement et la photo était retirée de la copie cloud** au lieu de retomber sur un embarquement compressé. Cette copie appauvrie pouvait ensuite se propager vers le stockage local (au chargement de l'app, ou depuis un autre appareil) et remplacer des photos locales pourtant intactes. Nouvelle fonction `_buildCloudTrips` (auth.js) : un échec d'upload retombe maintenant photo par photo sur un embarquement compressé (jamais de suppression silencieuse), avec `compressTripsForFirestore` en tout dernier recours si le lot entier dépasse encore la limite. `FIRESTORE_SIZE_LIMIT` exporté depuis utils.js pour partager le même seuil entre les deux fichiers |
| v166 | Photos lentes à charger depuis Storage | Deux causes : `uploadPhoto()` (photostore.js) envoyait la photo telle quelle, sans redimensionnement — une photo de téléphone (souvent 3000-4000px+) se charge lentement même juste pour une vignette. Ajout d'un redimensionnement à 2000px/qualité 0.88 avant upload (qualité toujours excellente à l'écran, fichier beaucoup plus léger) + `Cache-Control` immuable pour que les visites suivantes soient instantanées. Deuxième cause : `uploadPhoto()` n'avait pas de cache — chaque sync (à chaque édition, même sur un autre voyage) ré-uploadait les mêmes photos en boucle en créant un nouveau fichier à chaque fois (doublons orphelins dans Storage, bande passante gâchée qui ralentissait aussi le reste). Cache mémoire ajouté, keyed par contenu base64 |
| v167 | Stats de trace GPX (graphique altitude/vitesse) absentes de l'écran détail d'une sortie et de son info dans Mes destinations | `_buildAllPins` (mymap.js) ne copiait jamais `gpxStats`/`gpxPoints`/`gpxTrackId` depuis `trip.pin` pour une sortie (contrairement aux items de jour, qui les avaient déjà) — corrigé. Le bloc "🛤 Trace GPX" (badges + graphique interactif altitude/vitesse avec curseur tactile) n'existait que dans mymap.js ; extrait en fonctions partagées `gpxStatsBlockHtml(prefix, stats, points)` / `initGpxChart(prefix, points)` / `buildGpxChartSeries(points)` dans **gpx.js** (le `prefix` évite les collisions d'id entre les deux écrans). mymap.js les utilise désormais (au lieu de son code dupliqué) et `sortie.js` les utilise aussi pour afficher le même bloc dans l'écran détail d'une sortie, avec le tracé dessiné sur sa propre carte |
| v168 | Graphique GPX absent pour les voyages/week-ends dans Mes destinations ; photos supplémentaires d'une sortie introuvables | Import GPX (mapcal.js, `_openGpxImportModal`) sous-échantillonnait la trace à ≤300 points mais ne gardait que `{lat,lng}`, jetant `ele`/`time` — le graphique altitude/vitesse a besoin de ces deux champs pour avoir quoi que ce soit à tracer, donc il ne s'affichait jamais (seuls les badges de stats survivaient). Nouvelle fonction partagée `downsampleGpxPoints()` (gpx.js) qui garde le point complet ; utilisée à l'import. Auto-réparation pour les traces déjà importées : `_buildAllPins` (mymap.js) détecte un `item.gpxPoints` sans ele/time et le reconstruit depuis la trace complète encore stockée localement (`getLocalGpxTracks`), sans que l'utilisateur ait besoin de réimporter. Sortie : `_sortieInfoHtml` n'affichait que `trip.photo` (la bannière) — les photos supplémentaires ajoutées dans la modale (`trip.photos[1:]`) n'apparaissaient donc jamais ; ajout d'une bande de vignettes cliquables (ouvrant le lightbox `window._openSlides`) sous la bannière |
| v169 | Une photo supprimée n'était jamais effacée de Firebase Storage (orphelins qui s'accumulent) | `deletePhoto()` (photostore.js) existait depuis la migration Storage (v162) mais n'était appelée nulle part. `syncToFirestore` (auth.js) compare maintenant l'ensemble des URLs Storage référencées par tous les voyages avant/après chaque écriture (`_collectStorageUrls`, une seule fonction couvre à la fois une photo retirée et un voyage supprimé en entier) et supprime celles qui ont disparu, en best-effort après confirmation de l'écriture Firestore |
| v170 | Dizaines de doublons de la même photo dans Storage | Le cache anti-doublon ajouté en v166 n'était qu'en mémoire (`Map`) — il se réinitialisait à chaque rechargement de l'app, et une PWA est rouverte bien plus souvent qu'un onglet ne reste vivant : quasi chaque nouvelle session re-uploadait tout depuis zéro, créant un nouveau fichier à chaque fois pour une photo pourtant inchangée. Cache déplacé dans `localStorage` (persiste entre les sessions), indexé par un hash du contenu base64 plutôt que le contenu lui-même (pour ne pas gonfler le quota localStorage). `deletePhoto()` purge aussi l'entrée de cache correspondante, sinon re-ajouter une photo supprimée aurait renvoyé une URL déjà morte au lieu de la ré-uploader |
| v171 | Doublons déjà accumulés dans Storage avant le fix v170 (le nettoyage automatique du v169 n'agit qu'au fil des syncs, pas sur l'historique) | Nouvel outil de nettoyage manuel, accessible depuis Paramètres → Données → "🧹 Nettoyer les photos en double" (visible si connecté). `cleanupOrphanedPhotos(uid, referencedUrls)` (photostore.js) liste tous les fichiers de `users/{uid}/photos/` via `listAll()` et supprime ceux dont l'URL n'est référencée par aucun voyage. `cleanupDuplicatePhotos()` (auth.js) construit l'ensemble des URLs référencées en forçant une lecture fraîche du serveur (`getDocFromServer`, pas le cache IndexedDB) unie aux voyages locaux, pour ne jamais supprimer une photo d'un voyage pas encore synchronisé sur cet appareil |
| v172 | Passe de revue générale : temps de chargement, code mort, fuites de listeners | **Perf** : `mymap.js`, `share.js` (app.js) et `gpx.js` (home.js) passent d'imports statiques à `import()` à la demande — la plupart des sessions n'ouvrent jamais Ma Carte, un lien de partage ni n'importent de trace GPX depuis une sortie, donc ces modules (~110 Ko à eux trois) ne sont plus dans le bundle de démarrage ; `index.html` ne parse plus deux fois l'état complet (potentiellement plusieurs Mo à cause des photos base64) juste pour lire le thème au boot — nouvelle clé dédiée `carnet_theme`, tenue à jour par `_persistState()` (store.js) ; `destroyTripMap()` (trip.js) ne détruit plus que les modules d'onglet réellement ouverts pendant la session au lieu d'importer systématiquement mapcal/journal/sortie à chaque fermeture de voyage ; `sw.js` ne précache plus `import.js`/`export.js` (jamais utilisés qu'à la demande). **Bugs** : fuite de listeners `document` non bornée sur le menu ⊕ de l'accueil (`home.js`) et de Dépenses partagées (`tricount.js`) — un nouveau listener s'accumulait à chaque re-render au lieu d'être réutilisé, corrigé avec le même pattern WeakMap/garde déjà utilisé ailleurs dans le code (voir v154). **Nettoyage** : suppression de 6 fonctions mortes (`importPolarstepsZip`, `DEFAULT_PIN_TYPES`, `getDayLabel`, `saveUserSharedTripIds`, `exportTripPdf` + son `_buildPdfHtml` orphelin, `window._mmClearGpx`) et d'environ 140 sélecteurs CSS orphelins (anciennes classes de budget/tricount/packing/journal/accueil/mymap/partage remplacées par des refontes ultérieures), `style.css` passe de 126,5 Ko à 110,9 Ko |
| v173 | Partage externe d'une étape du Carnet (timeline) : les photos ne sont plus jointes | `_shareJournalItem` (journal.js) convertissait chaque photo en `File` via `Promise.all` avant de les passer à `navigator.share` — une seule photo dont le `fetch()` échoue (URL Storage expirée/supprimée, aléas réseau) faisait rejeter tout le lot via le comportement fail-fast de `Promise.all`, donc AUCUNE photo n'était jointe dès qu'une seule posait problème, même si les autres étaient valides. Remplacé par `Promise.allSettled` : les photos récupérées avec succès sont désormais jointes, celles en échec sont simplement ignorées individuellement |
| v174 | Photos toujours absentes du partage + parfois noires dans le Carnet (surtout à plusieurs éditeurs) ; message de partage avec le jour en double ; onglets manquants en mode observateur | **Photos manquantes/noires** : root cause probable — `transformTripPhotos` (utils.js) laisse volontairement une URL Storage déjà uploadée telle quelle plutôt que de la ré-embarquer, y compris lors de la compression pour `shared_trips` (partage) ; si cette même URL disparaît ensuite de la liste de photos du document personnel du propriétaire (nouvel upload, edit…), le nettoyage auto des orphelins Storage (v169) la supprimait alors qu'un voyage partagé la référençait toujours ailleurs → 404 pour les autres participants (`<img>` = carré noir, `fetch()` pour le partage = échec). `syncToFirestore` et `cleanupDuplicatePhotos` (auth.js) unissent maintenant les URLs référencées par les `shared_trips/{id}` de l'utilisateur (`_collectSharedTripsUrls`, lecture des docs partagés) à celles du document personnel avant de décider qu'un fichier est orphelin. **Message dupliqué** : `title` et la première ligne de `text` répétaient toutes les deux "tripName — Jour X" — beaucoup d'applications de partage (SMS, Mail…) affichent les deux à la suite, doublant l'info. `text` ne répète plus le header du `title`. **Onglets observateur** : le mode observateur mobile utilisait un layout carte+contenu côte-à-côte fixe (carte écrasée à 260px de haut) au lieu des 2 onglets plein écran carte/timeline déjà utilisés par le propriétaire/membre sur mobile — mêmes onglets `jn-mob-tabs`/`_journalMobTab` réutilisés pour l'observateur ; `_renderObserverView` (ancien mode "feed", jamais réellement atteignable depuis l'UI) supprimé avec son CSS associé |
