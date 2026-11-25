// Full-screen page reader: right-to-left by default, two-page spreads in
// landscape, swipe/tap navigation, pinch and double-tap zoom.
import { loadPages } from './library.js';
import { progress, settings } from './store.js';
import { AuthError } from './drive.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

export function openReader(root, ctx) {
  const { series, volume, volIndex, onExit, onOpenVolume, onAuthError, onError } = ctx;
  let cfg = settings.get();
  let pages = [];
  let views = [];
  let vi = 0;
  let destroyed = false;
  const dims = new Map(); // index -> aspect w/h
  const urls = new Map(); // index -> objectURL
  const loading = new Map();
  let uiVisible = false;

  // ----- DOM -----
  const imgA = h('img', { class: 'pg', alt: '', draggable: 'false' });
  const imgB = h('img', { class: 'pg', alt: '', draggable: 'false' });
  const spread = h('div', { class: 'spread' }, imgA, imgB);
  const zoomwrap = h('div', { class: 'zoomwrap' }, spread);
  const spinner = h('div', { class: 'spinner' });
  const endPanel = h('div', { class: 'endpanel', hidden: true });
  const stage = h('div', { class: 'stage' }, zoomwrap, spinner, endPanel);

  const title = h('div', { class: 'rtitle' }, h('span', { class: 'rseries' }, series.name), h('span', { class: 'rvol' }, volume.label));
  const settingsPanel = h('div', { class: 'rsettings', hidden: true });
  const topbar = h('div', { class: 'rbar rtop' },
    h('button', { class: 'btn ghost', onclick: () => exit() }, '‹ Back'),
    title,
    h('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); toggleSettings(); } }, 'Aa'));
  const slider = h('input', { type: 'range', min: '0', max: '0', value: '0', class: 'slider' });
  const pageNum = h('div', { class: 'pagenum' }, '');
  const prevVolBtn = h('button', { class: 'btn ghost small', onclick: () => gotoVolume(-1) }, 'Prev volume');
  const nextVolBtn = h('button', { class: 'btn ghost small', onclick: () => gotoVolume(1) }, 'Next volume');
  const bottombar = h('div', { class: 'rbar rbottom' }, prevVolBtn, h('div', { class: 'sliderwrap' }, slider, pageNum), nextVolBtn);
  const view = h('div', { class: 'reader' }, stage, topbar, bottombar, settingsPanel);
  root.replaceChildren(view);

  const prevVol = series.volumes.slice(0, volIndex).reverse().find((v) => v.type !== 'unsupported');
  const nextVol = series.volumes.slice(volIndex + 1).find((v) => v.type !== 'unsupported');
  prevVolBtn.disabled = !prevVol;
  nextVolBtn.disabled = !nextVol;

  function applyDir() {
    view.classList.toggle('rtl', cfg.dir === 'rtl');
    slider.setAttribute('dir', cfg.dir === 'rtl' ? 'rtl' : 'ltr');
    // In right-to-left reading, the earlier volume sits on the right.
    bottombar.classList.toggle('reverse', cfg.dir === 'rtl');
  }
  applyDir();

  // ----- Layout -----
  const isDouble = () => cfg.spread === 'double' || (cfg.spread === 'auto' && innerWidth > innerHeight * 1.05);
  const wide = (i) => (dims.get(i) || 0.7) > 1.0;

  function computeViews() {
    const n = pages.length;
    const out = [];
    if (!isDouble()) { for (let i = 0; i < n; i++) out.push([i]); return out; }
    let i = 0;
    if (cfg.coverAlone && n) { out.push([0]); i = 1; }
    while (i < n) {
      if (wide(i) || i + 1 >= n || wide(i + 1)) { out.push([i]); i++; }
      else { out.push([i, i + 1]); i += 2; }
    }
    return out;
  }
  const viewOf = (page) => Math.max(0, views.findIndex((v) => v.includes(page)));
  const curPage = () => (views[vi] ? views[vi][0] : 0);

  function relayout(anchor = curPage()) {
    views = computeViews();
    vi = viewOf(anchor);
    render();
  }

  // ----- Loading -----
  function ensure(i, priority) {
    if (i < 0 || i >= pages.length) return Promise.resolve(null);
    if (urls.has(i)) return Promise.resolve(urls.get(i));
    if (loading.has(i)) return loading.get(i);
    const p = (async () => {
      const blob = await pages[i].load(priority);
      if (destroyed) return null;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch {}
      const prevWide = wide(i);
      if (img.naturalWidth) dims.set(i, img.naturalWidth / img.naturalHeight);
      urls.set(i, url);
      if (wide(i) !== prevWide && isDouble()) relayout();
      return url;
    })();
    loading.set(i, p);
    p.catch((e) => {
      if (e instanceof AuthError) onAuthError();
    }).finally(() => loading.delete(i));
    return p;
  }

  function prefetch() {
    const base = curPage();
    const order = [];
    for (let d = 1; d <= 6; d++) order.push(base + d);
    order.push(base - 1, base - 2);
    let chain = Promise.resolve();
    // Load sequentially-ish: two at a time ahead, so the next page always wins.
    order.forEach((i, k) => {
      if (k < 2) ensure(i, true).catch(() => {});
      else chain = chain.then(() => ensure(i, false)).catch(() => {});
    });
    // Free memory far from the current page.
    for (const [i, u] of urls) {
      if (i < base - 8 || i > base + 14) { URL.revokeObjectURL(u); urls.delete(i); }
    }
  }

  let renderToken = 0;
  async function render() {
    if (!views.length) return;
    const v = views[vi];
    const my = ++renderToken;
    resetZoom();
    endPanel.hidden = true;
    spread.classList.toggle('two', v.length === 2);
    const show = (img, i) => {
      if (i == null) { img.hidden = true; img.removeAttribute('src'); return; }
      img.hidden = false;
      if (urls.has(i)) img.src = urls.get(i); else img.removeAttribute('src');
    };
    show(imgA, v[0]);
    show(imgB, v[1]);
    const missing = v.filter((i) => !urls.has(i));
    spinner.hidden = !missing.length;
    updateChrome();
    saveProgress();
    if (missing.length) {
      try {
        await Promise.all(v.map((i) => ensure(i, true)));
      } catch (e) {
        if (!(e instanceof AuthError)) onError(e);
        return;
      }
      if (my !== renderToken || destroyed) return;
      show(imgA, v[0]);
      show(imgB, v[1]);
      spinner.hidden = true;
    }
    prefetch();
  }

  function updateChrome() {
    const v = views[vi] || [0];
    slider.max = String(Math.max(0, pages.length - 1));
    slider.value = String(v[0]);
    const label = v.length === 2 ? `${v[0] + 1}-${v[1] + 1}` : `${v[0] + 1}`;
    pageNum.textContent = `${label} / ${pages.length}`;
  }

  function saveProgress() {
    const v = views[vi];
    if (!v || !pages.length) return;
    const last = vi === views.length - 1;
    progress.set(volume.id, last ? pages.length - 1 : v[0], pages.length);
  }

  // ----- Navigation -----
  function next() {
    if (!endPanel.hidden) return;
    if (vi < views.length - 1) { vi++; render(); }
    else showEnd();
  }
  function prev() {
    if (!endPanel.hidden) { endPanel.hidden = true; return; }
    if (vi > 0) { vi--; render(); }
  }
  function forward(dirSign) { // dirSign: +1 means visual "leftward" movement
    if (cfg.dir === 'rtl') dirSign > 0 ? next() : prev();
    else dirSign > 0 ? prev() : next();
  }

  function showEnd() {
    endPanel.replaceChildren(
      h('div', { class: 'endtitle' }, `Finished ${volume.label}`),
      nextVol
        ? h('button', { class: 'btn primary', onclick: () => gotoVolume(1) }, `Next: ${nextVol.label}`)
        : h('div', { class: 'muted' }, 'This is the last volume you have.'),
      h('button', { class: 'btn', onclick: () => exit() }, 'Back to series'),
    );
    endPanel.hidden = false;
  }

  function gotoVolume(d) {
    const v = d > 0 ? nextVol : prevVol;
    if (v) onOpenVolume(v);
  }
  function exit() { onExit(); }

  // ----- Chrome / settings -----
  function setUI(on) {
    uiVisible = on;
    view.classList.toggle('ui', on);
    if (!on) settingsPanel.hidden = true;
  }
  function toggleSettings() {
    if (!settingsPanel.hidden) { settingsPanel.hidden = true; return; }
    const opt = (key, val, label) => h('button', {
      class: 'seg' + (cfg[key] === val ? ' on' : ''),
      onclick: () => { settings.set({ [key]: val }); cfg = settings.get(); applyDir(); relayout(); toggleSettings(); toggleSettings(); },
    }, label);
    settingsPanel.replaceChildren(
      h('div', { class: 'srow' }, h('div', { class: 'slabel' }, 'Reading direction'),
        h('div', { class: 'segs' }, opt('dir', 'rtl', 'Right to left'), opt('dir', 'ltr', 'Left to right'))),
      h('div', { class: 'srow' }, h('div', { class: 'slabel' }, 'Pages'),
        h('div', { class: 'segs' }, opt('spread', 'auto', 'Auto'), opt('spread', 'single', 'Single'), opt('spread', 'double', 'Two-page'))),
      h('div', { class: 'srow' }, h('div', { class: 'slabel' }, 'Two-page pairing'),
        h('div', { class: 'segs' }, opt('coverAlone', true, 'Cover alone'), opt('coverAlone', false, 'Shift by one'))),
    );
    settingsPanel.hidden = false;
  }
  settingsPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  topbar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bottombar.addEventListener('pointerdown', (e) => e.stopPropagation());

  slider.addEventListener('input', () => {
    const p = Number(slider.value);
    pageNum.textContent = `${p + 1} / ${pages.length}`;
  });
  slider.addEventListener('change', () => { vi = viewOf(Number(slider.value)); render(); });

  // ----- Gestures -----
  let scale = 1, tx = 0, ty = 0;
  const pts = new Map();
  let start = null, pinch = null, lastTap = 0, tapTimer = null, moved = false;

  function applyZoom() {
    zoomwrap.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    view.classList.toggle('zoomed', scale > 1);
  }
  function resetZoom() { scale = 1; tx = 0; ty = 0; applyZoom(); }
  function clampPan() {
    const r = stage.getBoundingClientRect();
    const mx = (r.width * (scale - 1)) / 2, my = (r.height * (scale - 1)) / 2;
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  }
  function zoomAt(x, y, s) {
    const r = stage.getBoundingClientRect();
    const cx = x - r.left - r.width / 2, cy = y - r.top - r.height / 2;
    tx = (tx - cx) * (s / scale) + cx;
    ty = (ty - cy) * (s / scale) + cy;
    scale = s;
    if (scale <= 1.01) { resetZoom(); return; }
    clampPan();
    applyZoom();
  }

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY, t: performance.now(), tx, ty };
      moved = false;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: scale, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      moved = true;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const s = Math.max(1, Math.min(5, (pinch.s * d) / pinch.d));
      zoomAt(pinch.cx, pinch.cy, s);
    } else if (pts.size === 1 && start) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      if (scale > 1) { tx = start.tx + dx; ty = start.ty + dy; clampPan(); applyZoom(); }
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size > 0) { if (pts.size === 1) { const p = [...pts.values()][0]; start = { x: p.x, y: p.y, t: performance.now(), tx, ty }; } return; }
    pinch = null;
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    const dt = performance.now() - start.t;
    start = null;
    if (e.type === 'pointercancel') return;
    if (scale === 1 && moved && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 900) {
      // Finger moved right (dx>0): in RTL reading that pulls the next page in.
      forward(dx > 0 ? 1 : -1);
      if (uiVisible) setUI(false);
      return;
    }
    if (moved) return;
    onTap(e.clientX, e.clientY);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  function onTap(x, y) {
    const now = performance.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer);
      lastTap = 0;
      if (scale > 1) resetZoom(); else zoomAt(x, y, 2.5);
      return;
    }
    lastTap = now;
    if (!endPanel.hidden) return;
    const w = stage.clientWidth;
    const zone = x / w;
    if (scale === 1 && zone < 0.3) { forward(1); if (uiVisible) setUI(false); return; }
    if (scale === 1 && zone > 0.7) { forward(-1); if (uiVisible) setUI(false); return; }
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => setUI(!uiVisible), 260);
  }

  const noGesture = (e) => e.preventDefault();
  document.addEventListener('gesturestart', noGesture);
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') forward(1);
    else if (e.key === 'ArrowRight') forward(-1);
    else if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); next(); }
    else if (e.key === 'PageUp') prev();
    else if (e.key === 'Escape') exit();
  };
  document.addEventListener('keydown', onKey);
  let rt = null;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(() => relayout(), 120); };
  addEventListener('resize', onResize);

  // ----- Start -----
  (async () => {
    spinner.hidden = false;
    try {
      pages = await loadPages(volume);
    } catch (e) {
      if (destroyed) return;
      spinner.hidden = true;
      if (e instanceof AuthError) onAuthError();
      else {
        endPanel.replaceChildren(h('div', { class: 'endtitle' }, 'Could not open this volume'), h('div', { class: 'muted' }, e.message || String(e)),
          h('button', { class: 'btn', onclick: () => exit() }, 'Back'));
        endPanel.hidden = false;
      }
      return;
    }
    if (destroyed) return;
    const saved = progress.get(volume.id);
    let startPage = saved && saved.page < pages.length - 1 ? saved.page : 0;
    if (ctx.startPage != null) startPage = ctx.startPage;
    views = computeViews();
    vi = viewOf(startPage);
    render();
  })();

  return {
    destroy() {
      destroyed = true;
      document.removeEventListener('gesturestart', noGesture);
      document.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
    },
  };
}
