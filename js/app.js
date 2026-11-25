import * as auth from './auth.js';
import * as drive from './drive.js';
import { scanLibrary, cachedLibrary, coverURL, findVolume, collator } from './library.js';
import { openReader } from './reader.js';
import { progress, settings, idbClear, getJSON, setJSON } from './store.js';

const $app = document.getElementById('app');
const VERSION = '1.0.0';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

function toast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

const rootName = () => getJSON('mr.rootName', null) || window.MR_CONFIG?.rootFolderName || '漫画';

// ---------- State ----------
let lib = cachedLibrary();
let scanning = null;
let reader = null;
let authBannerShown = false;

function onAuthError() {
  if (authBannerShown) return;
  authBannerShown = true;
  const b = h('div', { class: 'authbanner' },
    h('span', {}, 'Your Google sign-in expired.'),
    h('button', { class: 'btn primary small', onclick: () => auth.signIn(location.hash) }, 'Reconnect'));
  document.body.append(b);
}

function onError(e) {
  console.error(e);
  if (e instanceof drive.AuthError) return onAuthError();
  toast(e.message || String(e));
}

async function rescan() {
  if (scanning) return scanning;
  const bar = document.querySelector('.scanstatus');
  scanning = scanLibrary(rootName(), (d, n) => {
    const s = document.querySelector('.scanstatus');
    if (s) s.textContent = `Scanning Drive… ${d}/${n} series`;
  }).then((l) => {
    lib = l;
    return l;
  }).catch((e) => { onError(e); throw e; })
    .finally(() => { scanning = null; });
  if (bar) bar.textContent = 'Scanning Drive…';
  return scanning;
}

// ---------- Cover lazy loading ----------
const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    io.unobserve(en.target);
    loadCover(en.target);
  }
}, { rootMargin: '400px' }) : null;

const volIndex = new Map();
function indexVolumes() {
  volIndex.clear();
  for (const s of lib?.series || []) for (const v of s.volumes) volIndex.set(v.id, v);
}

function loadCover(el) {
  const v = volIndex.get(el.dataset.vol);
  if (!v || v.type === 'unsupported') { el.classList.add('nocover'); return; }
  coverURL(v).then((url) => {
    if (url) { el.style.backgroundImage = `url("${url}")`; el.classList.add('loaded'); }
    else el.classList.add('nocover');
  }).catch((e) => {
    el.classList.add('nocover');
    if (e instanceof drive.AuthError) onAuthError();
  });
}

function cover(vol, label) {
  const el = h('div', { class: 'cover', 'data-vol': vol?.id || '' }, label ? h('div', { class: 'coverlabel' }, label) : null);
  if (vol) { if (io) io.observe(el); else loadCover(el); }
  return el;
}

// ---------- Progress helpers ----------
function volState(v) {
  const p = progress.get(v.id);
  if (!p) return { pct: 0, done: false, started: false };
  const done = p.total > 0 && p.page >= p.total - 1;
  return { pct: p.total ? (p.page + 1) / p.total : 0, done, started: true, t: p.t };
}
function seriesState(s) {
  let done = 0, t = 0;
  for (const v of s.volumes) {
    const st = volState(v);
    if (st.done) done++;
    if (st.t > t) t = st.t;
  }
  return { done, total: s.volumes.length, t };
}
function nextToRead(s) {
  const readable = s.volumes.filter((v) => v.type !== 'unsupported');
  const inProg = readable.filter((v) => { const st = volState(v); return st.started && !st.done; })
    .sort((a, b) => volState(b).t - volState(a).t)[0];
  if (inProg) return inProg;
  let lastDone = -1;
  readable.forEach((v, i) => { if (volState(v).done) lastDone = i; });
  return readable[lastDone + 1] || readable[0];
}
const bar = (pct) => h('div', { class: 'pbar' }, h('div', { style: `width:${Math.round(pct * 100)}%` }));

// ---------- Views ----------
function setupView() {
  const input = h('input', { class: 'field', placeholder: 'xxxxxxxx.apps.googleusercontent.com', value: auth.getClientId() });
  $app.replaceChildren(h('div', { class: 'page narrow' },
    h('h1', {}, '漫画 Reader setup'),
    h('p', {}, 'Paste the OAuth Client ID from Google Cloud. You only do this once on each device.'),
    h('p', { class: 'muted' }, 'This page must be listed as an "Authorized JavaScript origin" and "Authorized redirect URI" for that client:'),
    h('pre', { class: 'code' }, `Origin:       ${location.origin}\nRedirect URI: ${auth.redirectUri()}`),
    input,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => {
        if (!/apps\.googleusercontent\.com$/.test(input.value.trim())) { toast('That does not look like a Client ID'); return; }
        auth.setClientId(input.value);
        location.hash = '#/';
        route();
      } }, 'Save')),
  ));
}

function signInView() {
  $app.replaceChildren(h('div', { class: 'page narrow center' },
    h('div', { class: 'logo' }, '漫'),
    h('h1', {}, '漫画 Reader'),
    h('p', { class: 'muted' }, `Reads your “${rootName()}” folder straight from Google Drive. Nothing is downloaded to this iPad except small cover thumbnails.`),
    h('button', { class: 'btn primary big', onclick: () => auth.signIn(location.hash || '#/') }, 'Sign in with Google'),
    h('p', { class: 'muted small' }, 'Read-only access. The app never changes or deletes anything in your Drive.'),
  ));
}

function header(left, titleText, right) {
  return h('header', { class: 'top' }, h('div', { class: 'tl' }, left), h('h1', {}, titleText), h('div', { class: 'tr' }, right));
}

let homeFilter = getJSON('mr.homeFilter', 'all');
let searchText = '';

function homeView() {
  if (!lib) {
    $app.replaceChildren(h('div', { class: 'page center' }, h('div', { class: 'spinner static' }), h('p', { class: 'scanstatus muted' }, 'Scanning Drive…')));
    rescan().then(() => route()).catch((e) => {
      $app.replaceChildren(h('div', { class: 'page narrow center' }, h('h2', {}, 'Could not load your library'), h('p', { class: 'muted' }, e.message || String(e)),
        h('button', { class: 'btn', onclick: () => route() }, 'Try again'), h('a', { class: 'btn ghost', href: '#/settings' }, 'Settings')));
    });
    return;
  }
  indexVolumes();
  const cfg = settings.get();

  // Continue reading shelf
  const inProgress = [];
  for (const s of lib.series) for (const v of s.volumes) {
    const st = volState(v);
    if (st.started && !st.done) inProgress.push({ s, v, t: st.t, pct: st.pct });
  }
  inProgress.sort((a, b) => b.t - a.t);
  const shelf = inProgress.slice(0, 12).map(({ s, v, pct }) =>
    h('a', { class: 'shelfitem', href: `#/r/${encodeURIComponent(v.id)}` },
      cover(v), bar(pct), h('div', { class: 'cardtitle' }, s.name), h('div', { class: 'cardsub' }, v.label)));

  // Series grid
  let list = lib.series.slice();
  const q = searchText.trim().toLowerCase();
  if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
  if (homeFilter !== 'all') list = list.filter((s) => {
    const st = seriesState(s);
    if (homeFilter === 'reading') return st.t && st.done < st.total;
    if (homeFilter === 'unread') return !st.t;
    if (homeFilter === 'done') return st.done === st.total;
    return true;
  });
  if (cfg.sort === 'recent') list.sort((a, b) => seriesState(b).t - seriesState(a).t || collator.compare(a.name, b.name));
  else if (cfg.sort === 'added') list.sort((a, b) => (b.added || '').localeCompare(a.added || ''));
  else list.sort((a, b) => collator.compare(a.name, b.name));

  const grid = h('div', { class: 'grid' }, list.map((s) => {
    const st = seriesState(s);
    const first = s.volumes.find((v) => v.type !== 'unsupported');
    return h('a', { class: 'card', href: `#/s/${encodeURIComponent(s.id)}` },
      cover(first, `${s.volumes.length}巻`),
      st.done ? bar(st.done / st.total) : null,
      h('div', { class: 'cardtitle' }, s.name),
      h('div', { class: 'cardsub' }, st.done ? `${st.done} of ${st.total} read` : `${st.total} volumes`));
  }));

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search series', value: searchText,
    oninput: (e) => { searchText = e.target.value; const pos = e.target.selectionStart; homeView(); const n = document.querySelector('.search'); n.focus(); n.setSelectionRange(pos, pos); } });
  const chip = (key, label) => h('button', { class: 'chip' + (homeFilter === key ? ' on' : ''), onclick: () => { homeFilter = key; setJSON('mr.homeFilter', key); homeView(); } }, label);
  const sortSel = h('select', { class: 'select', onchange: (e) => { settings.set({ sort: e.target.value }); homeView(); } },
    [['name', 'Title'], ['recent', 'Recently read'], ['added', 'Recently added']].map(([v, l]) => h('option', { value: v, selected: cfg.sort === v }, l)));

  const scroller = document.querySelector('.page.home');
  const keepScroll = scroller ? scroller.scrollTop : 0;
  const totalVols = lib.series.reduce((n, s) => n + s.volumes.length, 0);
  const page = h('div', { class: 'page home' },
    header(h('div', { class: 'brand' }, '漫画'), '', h('div', { class: 'row' },
      h('button', { class: 'btn ghost', title: 'Rescan Drive', onclick: () => { rescan().then(() => { toast('Library updated'); homeView(); }).catch(() => {}); } }, '↻'),
      h('a', { class: 'btn ghost', href: '#/settings' }, 'Settings'))),
    h('div', { class: 'scanstatus muted small' }, scanning ? 'Scanning Drive…' : ''),
    shelf.length ? h('section', {}, h('h2', {}, 'Continue reading'), h('div', { class: 'shelf' }, shelf)) : null,
    h('section', {},
      h('div', { class: 'toolbar' }, search, sortSel),
      h('div', { class: 'chips' }, chip('all', 'All'), chip('reading', 'Reading'), chip('unread', 'Not started'), chip('done', 'Finished')),
      h('div', { class: 'muted small count' }, `${list.length} series · ${totalVols} volumes`),
      list.length ? grid : h('p', { class: 'muted' }, 'Nothing here.')),
  );
  $app.replaceChildren(page);
  page.scrollTop = keepScroll;
}

function seriesView(id) {
  if (!lib) return homeView();
  indexVolumes();
  const s = lib.series.find((x) => x.id === id);
  if (!s) { location.hash = '#/'; return; }
  const nxt = nextToRead(s);
  const nst = nxt ? volState(nxt) : null;
  const st = seriesState(s);
  const grid = h('div', { class: 'grid vols' }, s.volumes.map((v) => {
    const vs = volState(v);
    const unsupported = v.type === 'unsupported';
    const el = h(unsupported ? 'div' : 'a', { class: 'card' + (unsupported ? ' disabled' : '') + (vs.done ? ' done' : ''), href: unsupported ? null : `#/r/${encodeURIComponent(v.id)}` },
      cover(unsupported ? null : v, vs.done ? '✓ Read' : null),
      vs.started && !vs.done ? bar(vs.pct) : null,
      h('div', { class: 'cardtitle' }, v.label),
      unsupported ? h('div', { class: 'cardsub' }, 'RAR/PDF not supported') : null);
    if (!unsupported) attachLongPress(el, () => volumeMenu(v));
    return el;
  }));
  const page = h('div', { class: 'page' },
    header(h('a', { class: 'btn ghost', href: '#/' }, '‹ Library'), s.name, null),
    h('div', { class: 'serieshead' },
      h('div', { class: 'muted' }, `${s.volumes.length} volumes · ${st.done} read`),
      nxt ? h('a', { class: 'btn primary', href: `#/r/${encodeURIComponent(nxt.id)}` }, nst?.started ? `Continue ${nxt.label}` : `Read ${nxt.label}`) : null),
    grid,
    h('p', { class: 'muted small' }, 'Tip: press and hold a volume to mark it read or unread.'));
  $app.replaceChildren(page);
}

function attachLongPress(el, fn) {
  let t = null, fired = false;
  el.addEventListener('pointerdown', () => { fired = false; t = setTimeout(() => { fired = true; fn(); }, 550); });
  const cancel = () => clearTimeout(t);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancel(); });
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', (e) => { if (fired) e.preventDefault(); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function volumeMenu(v) {
  const st = volState(v);
  const close = () => sheet.remove();
  const sheet = h('div', { class: 'sheetbg', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'sheettitle' }, v.label),
      h('button', { class: 'btn', onclick: () => { progress.mark(v.id, !st.done, progress.get(v.id)?.total || 1); close(); route(); } }, st.done ? 'Mark as unread' : 'Mark as read'),
      st.started ? h('button', { class: 'btn', onclick: () => { progress.set(v.id, 0, progress.get(v.id)?.total || 1); location.hash = `#/r/${encodeURIComponent(v.id)}`; close(); } }, 'Read from the beginning') : null,
      h('button', { class: 'btn ghost', onclick: close }, 'Cancel')));
  document.body.append(sheet);
}

function settingsView() {
  const cfg = settings.get();
  const seg = (key, val, label) => h('button', { class: 'seg' + (cfg[key] === val ? ' on' : ''), onclick: () => { settings.set({ [key]: val }); settingsView(); } }, label);
  const folder = h('input', { class: 'field', value: rootName() });
  $app.replaceChildren(h('div', { class: 'page narrow' },
    header(h('a', { class: 'btn ghost', href: '#/' }, '‹ Library'), 'Settings', null),
    h('section', { class: 'card-plain' },
      h('h2', {}, 'Reading'),
      h('div', { class: 'srow' }, h('div', { class: 'slabel' }, 'Direction'), h('div', { class: 'segs' }, seg('dir', 'rtl', 'Right to left'), seg('dir', 'ltr', 'Left to right'))),
      h('div', { class: 'srow' }, h('div', { class: 'slabel' }, 'Pages'), h('div', { class: 'segs' }, seg('spread', 'auto', 'Auto'), seg('spread', 'single', 'Single'), seg('spread', 'double', 'Two-page'))),
      h('p', { class: 'muted small' }, 'Auto shows one page in portrait and a two-page spread in landscape.')),
    h('section', { class: 'card-plain' },
      h('h2', {}, 'Library'),
      h('div', { class: 'slabel' }, 'Google Drive folder name'),
      h('div', { class: 'row' }, folder, h('button', { class: 'btn', onclick: () => { setJSON('mr.rootName', folder.value.trim() || '漫画'); lib = null; location.hash = '#/'; } }, 'Use')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { lib = null; location.hash = '#/'; route(); } }, 'Rescan Drive'),
        h('button', { class: 'btn', onclick: async () => { await idbClear('covers'); await idbClear('pages'); toast('Cache cleared'); } }, 'Clear cached covers')),
      lib ? h('p', { class: 'muted small' }, `Last scanned ${new Date(lib.scannedAt).toLocaleString()}`) : null),
    h('section', { class: 'card-plain' },
      h('h2', {}, 'Account'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { auth.signOut(); route(); } }, 'Sign out'),
        h('a', { class: 'btn ghost', href: '#/setup' }, 'Change Client ID'))),
    h('p', { class: 'muted small' }, `Version ${VERSION}`),
  ));
}

function readerView(volId) {
  if (!lib) return homeView();
  const found = findVolume(lib, volId);
  if (!found) { location.hash = '#/'; return; }
  const { series, volume, index } = found;
  reader = openReader($app, {
    series, volume, volIndex: index,
    onExit: () => { location.hash = `#/s/${encodeURIComponent(series.id)}`; },
    onOpenVolume: (v) => { location.hash = `#/r/${encodeURIComponent(v.id)}`; },
    onAuthError, onError,
  });
}

// ---------- Router ----------
function route() {
  if (reader) { reader.destroy(); reader = null; }
  document.body.classList.remove('reading');
  const hash = location.hash || '#/';
  if (hash.startsWith('#/setup')) return setupView();
  if (!auth.getClientId()) return setupView();
  if (!auth.token()) return signInView();
  const [, kind, id] = hash.match(/^#\/(\w+)?\/?([^?]*)/) || [];
  if (kind === 's') return seriesView(decodeURIComponent(id));
  if (kind === 'r') { document.body.classList.add('reading'); return readerView(decodeURIComponent(id)); }
  if (kind === 'settings') return settingsView();
  return homeView();
}

// ---------- Boot ----------
const res = auth.handleRedirect();
if (res?.error) toast('Sign-in failed: ' + res.error);
if (res?.ok) {
  drive.aboutEmail().then((em) => { if (em) try { localStorage.setItem('mr.email', em); } catch {} });
}
addEventListener('hashchange', route);
route();

// Refresh the library in the background if it is more than 6 hours old.
if (lib && auth.token() && Date.now() - (lib.scannedAt || 0) > 6 * 3600e3) {
  rescan().then(() => { if (!document.body.classList.contains('reading') && !(location.hash || '').startsWith('#/settings')) route(); }).catch(() => {});
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
