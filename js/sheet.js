/* ============================================================
   CARNET DE VOYAGES — Feuille glissante sur carte (écran voyage)
   ============================================================
   Même mécanique que la feuille profil de l'accueil (home.js, réglée
   au fil des v231–v236) : 3 crans (peek / mid / full), uniquement des
   transform/opacity en style en ligne, une mise à jour par image pendant
   le glissé, carte décalée de la moitié du déplacement (le globe reste
   centré dans la zone visible), relâcher à la vitesse du doigt puis
   décélération jusqu'au cran suivant dans le sens du geste, flous coupés
   pendant le mouvement, glissé horizontal optionnel (changement d'onglet).

   createSheet(cfg) → { setSnap(snap, animate), getSnap(), refresh() }
   cfg = {
     root, sheet, scroll, head?, grab?, top?, dim?, slot?,   // éléments
     mapExt: 260,                 // dépassement de la zone de carte au-dessus de l'écran
     wide: () => bool,            // grand écran : panneau fixe, pas de feuille
     snaps: () => ({ full, mid, peek }),
     onSnap?(snap),               // après chaque changement de cran
     onSwipe?(dir) → bool,        // glissé horizontal (dir = 1 vers la gauche) ; true = accepté
     initial: 'mid',
   }
   ============================================================ */

function _inHScroller(el, stop) {
  for (; el && el !== stop && el.nodeType === 1; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

export function createSheet(cfg) {
  const { root, sheet, scroll } = cfg;
  const mapExt = cfg.mapExt ?? 260;
  const wide   = cfg.wide || (() => false);
  let snap = cfg.initial || 'mid';
  let translate = null, headH = null, releaseVel = 0, dragging = false;
  let flatT = 0, animT = 0, snapT = 0, headRetry = false;

  const headEl = () => cfg.head || scroll.querySelector('.tv2-sheet-head');

  function apply(t, animate) {
    const from = translate ?? t;
    translate = t;
    const H   = window.innerHeight;
    const mid = Math.max(1, Math.round(H * 0.5));
    const p   = Math.max(0, Math.min(1, 1 - t / mid));
    // Relâcher : départ à la vitesse du doigt puis décélération ; sinon départ en douceur
    const dist = Math.abs(t - from);
    const v = releaseVel * Math.sign(t - from);
    releaseVel = 0;
    let ms, curve;
    if (v > 0.05 && dist > 1) {
      ms = Math.round(Math.max(260, Math.min(600, (2 * dist) / v)));
      curve = `cubic-bezier(.33,${Math.min(1, ((v * ms) / dist) * 0.33).toFixed(3)},.66,1)`;
    } else {
      ms = Math.round(Math.max(320, Math.min(560, 300 + dist * 0.45)));
      curve = 'cubic-bezier(.4,0,.2,1)';
    }
    const ease = `${ms}ms ${curve}`;
    const trT = animate ? `transform ${ease}` : 'none';
    const trO = animate ? `opacity ${ease}` : 'none';
    const head = headEl();
    if (!headH && head) headH = head.offsetHeight || null;
    if (!headH && head && !headRetry) {
      // Écran encore masqué au 1er rendu : on réapplique dès qu'il est visible
      headRetry = true;
      const retry = () => {
        if (!root.isConnected) { headRetry = false; return; }
        const h = headEl()?.offsetHeight;
        // masqué (écran pas encore affiché, sous-vue ouverte) : on revérifie sans
        // relire la mise en page à chaque image
        if (!h) { if (root.offsetParent) requestAnimationFrame(retry); else setTimeout(retry, 300); return; }
        headRetry = false; headH = h;
        if (!wide()) apply(translate, false);
      };
      requestAnimationFrame(retry);
    }
    const shift = (21 - (headH || 58)) * (1 - p);

    sheet.style.transition = trT;
    sheet.style.transform  = `translate3d(0,${t}px,0)`;
    scroll.style.transition = trT;
    scroll.style.transform  = `translate3d(0,${shift}px,0)`;
    if (cfg.slot) {
      cfg.slot.style.transition = trT;
      cfg.slot.style.transform  = `translate3d(0,${Math.min(mapExt - 10, (t - mid) / 2)}px,0)`;
    }
    if (head)     { head.style.transition = trO; head.style.opacity = p; head.style.pointerEvents = p > 0.9 ? 'auto' : 'none'; }
    if (cfg.grab) { cfg.grab.style.transition = trO; cfg.grab.style.opacity = 1 - p; }
    if (cfg.top)  {
      cfg.top.style.transition = trO; cfg.top.style.opacity = 1 - p;
      // Classe et pas seulement pointer-events sur le parent : ses boutons ont pointer-events:auto
      // et restaient cliquables, invisibles, par-dessus ceux de l'en-tête de la feuille (plein écran).
      cfg.top.classList.toggle('tv2-top-off', p > 0.92);
    }
    if (cfg.dim)  { cfg.dim.style.transition  = trO; cfg.dim.style.opacity  = (p * 0.8).toFixed(3); }
    clearTimeout(animT);
    if (animate) {
      root.classList.add('tv2-anim');
      animT = setTimeout(() => { if (!dragging) root.classList.remove('tv2-anim'); }, ms + 40);
    } else if (!dragging) root.classList.remove('tv2-anim');
    clearTimeout(flatT);
    if (p < 0.999) sheet.classList.remove('tv2-sheet-flat');
    else if (animate) flatT = setTimeout(() => sheet.classList.add('tv2-sheet-flat'), ms);
    else sheet.classList.add('tv2-sheet-flat');
  }

  function setSnap(s, animate = true) {
    snap = s;
    clearTimeout(snapT);
    if (animate && !wide()) snapT = setTimeout(() => { root.dataset.snap = s; }, 500);
    else root.dataset.snap = s;
    if (wide()) {
      sheet.style.transform = ''; scroll.style.transform = '';
      if (cfg.slot) cfg.slot.style.transform = '';
      for (const el of [cfg.top, cfg.dim, headEl(), cfg.grab]) if (el) el.style.opacity = '';
      cfg.top?.classList.remove('tv2-top-off');
    } else {
      apply(cfg.snaps()[s], animate);
    }
    cfg.onSnap?.(s);
  }

  // ── Gestes ───────────────────────────────────────────────────────────────────
  let startY = 0, startX = 0, lastX = 0, startT = 0, mode = null, samples = [], snaps0 = null;
  let raf = 0, pendingT = null, suppressClick = false, target0 = null;

  const velocity = key => {
    const now = performance.now();
    const r = samples.filter(sm => now - sm.t <= 100);
    if (r.length < 2) return 0;
    return (r[r.length - 1][key] - r[0][key]) / Math.max(16, r[r.length - 1].t - r[0].t);
  };
  const begin = (y, x, target) => {
    suppressClick = false;
    startY = y; startX = lastX = x; target0 = target;
    startT = translate ?? 0; mode = null; pendingT = null; snaps0 = null;
    samples = [{ y, x, t: performance.now() }];
  };
  const move = (y, x, e) => {
    lastX = x;
    if (!mode) {
      const dy0 = y - startY, dx0 = x - startX;
      if (Math.abs(dy0) < 6 && Math.abs(dx0) < 6) return;
      if (cfg.onSwipe && Math.abs(dx0) > Math.abs(dy0) * 1.2 && snap !== 'peek' && !_inHScroller(target0, scroll)) {
        mode = 'swipe';
      } else {
        if (Math.abs(dy0) < 6) return;
        mode = (snap !== 'full' || (scroll.scrollTop <= 0 && dy0 > 0)) ? 'sheet' : 'scroll';
        if (mode === 'sheet') { startY = y; dragging = true; root.classList.add('tv2-anim'); }
      }
    }
    if (mode === 'swipe') {
      e?.cancelable && e.preventDefault();
      samples.push({ y, x, t: performance.now() }); if (samples.length > 12) samples.shift();
      const pane = scroll.querySelector('.tv2-pane');
      if (pane) { pane.style.transition = 'none'; pane.style.transform = `translate3d(${(x - startX) * 0.5}px,0,0)`; }
      return;
    }
    if (mode !== 'sheet') return;
    e?.cancelable && e.preventDefault();
    samples.push({ y, x, t: performance.now() }); if (samples.length > 12) samples.shift();
    if (!snaps0) snaps0 = cfg.snaps();
    pendingT = Math.max(0, Math.min(snaps0.peek + 20, startT + (y - startY)));
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pendingT != null) apply(pendingT, false); });
  };
  const end = () => {
    if (mode === 'swipe') {
      mode = null;
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 400);
      const dx = lastX - startX, vx = velocity('x');
      const pane = scroll.querySelector('.tv2-pane');
      const ok = (Math.abs(dx) > 70 || (Math.abs(dx) > 30 && Math.abs(vx) > 0.35)) && cfg.onSwipe(dx < 0 ? 1 : -1);
      if (!ok && pane) { pane.style.transition = 'transform .22s cubic-bezier(.22,.7,.25,1)'; pane.style.transform = 'translate3d(0,0,0)'; }
      return;
    }
    if (mode !== 'sheet') { mode = null; return; }
    dragging = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (pendingT != null) { apply(pendingT, false); pendingT = null; }
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 400);
    const vel = velocity('y');
    const snaps = cfg.snaps();
    const order = ['full', 'mid', 'peek'];
    const t = translate, moved = t - startT;
    const dir = Math.abs(vel) > 0.08 ? Math.sign(vel) : (Math.abs(moved) > 12 ? Math.sign(moved) : 0);
    let tgt;
    if (dir > 0)      tgt = order.find(sn => snaps[sn] > t + 4) || 'peek';
    else if (dir < 0) tgt = [...order].reverse().find(sn => snaps[sn] < t - 4) || 'full';
    else              tgt = order.reduce((b, sn) => Math.abs(snaps[sn] - t) < Math.abs(snaps[b] - t) ? sn : b, 'mid');
    mode = null;
    releaseVel = vel;
    setSnap(tgt, true);
  };

  sheet.addEventListener('touchstart', e => { if (!wide()) begin(e.touches[0].clientY, e.touches[0].clientX, e.target); }, { passive: true });
  sheet.addEventListener('touchmove',  e => { if (!wide()) move(e.touches[0].clientY, e.touches[0].clientX, e); }, { passive: false });
  sheet.addEventListener('touchend',   () => { if (!wide()) end(); });
  sheet.addEventListener('touchcancel',() => { if (!wide()) end(); });
  cfg.grab?.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || wide()) return;
    begin(e.clientY, e.clientX, e.target);
    const mm = ev => move(ev.clientY, ev.clientX, ev);
    const mu = () => { end(); window.removeEventListener('pointermove', mm); window.removeEventListener('pointerup', mu); };
    window.addEventListener('pointermove', mm);
    window.addEventListener('pointerup', mu);
  });
  cfg.grab?.addEventListener('click', () => { if (!wide()) setSnap(snap === 'peek' ? 'mid' : snap === 'mid' ? 'full' : 'mid'); });
  sheet.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  // Feuille masquée (sous-vue Budget/Bagages ouverte) : rien à recalculer — sinon la
  // relance « en-tête pas encore mesuré » tournait à chaque image jusqu'au retour
  const onResize = () => { headH = null; if (root.isConnected && root.offsetParent) setSnap(snap, false); };
  window.addEventListener('resize', onResize);

  return {
    setSnap,
    getSnap: () => snap,
    refresh: () => setSnap(snap, false),
    destroy: () => window.removeEventListener('resize', onResize),
  };
}
