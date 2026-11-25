// Builds the library (series -> volumes) from the Drive folder, and knows how
// to list and load the pages of a volume, whatever form it is stored in.
import * as drive from './drive.js';
import { readDirectory, readEntry } from './zip.js';
import { getJSON, setJSON, idbGet, idbSet } from './store.js';

const IMG = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const ZIP = /\.(zip|cbz)$/i;
const UNSUPPORTED = /\.(rar|cbr|7z|cb7|pdf|epub)$/i;
export const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

const toHalf = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function parseVolumeNumber(name) {
  const s = toHalf(name.replace(ZIP, '').replace(UNSUPPORTED, ''));
  let m = s.match(/第\s*(\d+(?:\.\d+)?)\s*[巻話集]/) ||
    s.match(/(?:^|[\s_\-\[(])(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)/i) ||
    s.match(/(\d+(?:\.\d+)?)\s*巻/) ||
    s.match(/(?:^|\D)(\d{1,3})(?:\D*)$/);
  return m ? parseFloat(m[1]) : null;
}

function cleanTitle(name) {
  return name.replace(ZIP, '').replace(UNSUPPORTED, '')
    .replace(/^\s*(\([^)]*\)|\[[^\]]*\]|【[^】]*】)\s*/g, '')
    .replace(/^\s*(\([^)]*\)|\[[^\]]*\]|【[^】]*】)\s*/g, '')
    .trim() || name;
}

function volumeLabel(name, num) {
  if (num != null) return `第${num}巻`;
  return cleanTitle(name);
}

const LIB_KEY = 'mr.library';
export const cachedLibrary = () => getJSON(LIB_KEY, null);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function volumesFrom(children, seriesId, seriesName) {
  const vols = [];
  const looseImages = children.filter((c) => IMG.test(c.name));
  for (const c of children) {
    let type = null;
    if (c.mimeType === drive.FOLDER) type = 'folder';
    else if (ZIP.test(c.name) || c.mimeType === 'application/zip' || c.mimeType === 'application/x-zip-compressed') type = 'zip';
    else if (UNSUPPORTED.test(c.name)) type = 'unsupported';
    if (!type) continue;
    const num = parseVolumeNumber(c.name);
    vols.push({
      id: c.id, name: c.name, type, num,
      label: volumeLabel(c.name, num),
      size: Number(c.size) || 0,
      added: c.createdTime || c.modifiedTime || '',
      modified: c.modifiedTime || '',
    });
  }
  if (looseImages.length && !vols.some((v) => v.type !== 'unsupported')) {
    vols.push({ id: seriesId, name: seriesName, type: 'folder', num: null, label: seriesName, size: 0, added: looseImages[0].createdTime || '', modified: '' });
  }
  // The same volume can be both a folder of images and a ZIP. Keep one.
  const byNum = new Map();
  const result = [];
  const rank = { folder: 0, zip: 1, unsupported: 2 };
  for (const v of vols) {
    if (v.num == null) { result.push(v); continue; }
    const prev = byNum.get(v.num);
    if (!prev) { byNum.set(v.num, v); continue; }
    const [keep, drop] = rank[v.type] < rank[prev.type] ? [v, prev] : [prev, v];
    if (drop.type !== 'unsupported') keep.alt = { id: drop.id, type: drop.type, size: drop.size };
    byNum.set(v.num, keep);
  }
  result.push(...byNum.values());
  result.sort((a, b) => {
    if (a.num != null && b.num != null && a.num !== b.num) return a.num - b.num;
    if (a.num == null && b.num != null) return 1;
    if (b.num == null && a.num != null) return -1;
    return collator.compare(a.name, b.name);
  });
  return result;
}

export async function scanLibrary(rootName, onProgress) {
  const root = await drive.findFolder(rootName);
  if (!root) throw new Error(`Could not find a folder named "${rootName}" in your Google Drive.`);
  const top = await drive.listChildren(root.id);
  const seriesFolders = top.filter((c) => c.mimeType === drive.FOLDER);
  let done = 0;
  const series = await pool(seriesFolders, 4, async (f) => {
    const kids = await drive.listChildren(f.id);
    onProgress && onProgress(++done, seriesFolders.length);
    const volumes = volumesFrom(kids, f.id, f.name);
    return {
      id: f.id, name: f.name, volumes,
      added: volumes.reduce((m, v) => (v.added > m ? v.added : m), f.createdTime || ''),
    };
  });
  const loose = volumesFrom(top.filter((c) => c.mimeType !== drive.FOLDER), root.id, 'その他');
  if (loose.length) series.push({ id: root.id + ':loose', name: 'その他', volumes: loose, added: '' });
  const lib = {
    rootId: root.id,
    scannedAt: Date.now(),
    series: series.filter((s) => s.volumes.length).sort((a, b) => collator.compare(a.name, b.name)),
  };
  setJSON(LIB_KEY, lib);
  return lib;
}

export function findVolume(lib, id) {
  for (const s of lib?.series || []) {
    const i = s.volumes.findIndex((v) => v.id === id);
    if (i >= 0) return { series: s, volume: s.volumes[i], index: i };
  }
  return null;
}

// ---------- Pages ----------

async function listImagesRecursive(folderId, depth = 0) {
  const kids = await drive.listChildren(folderId);
  let imgs = kids.filter((k) => IMG.test(k.name) || /^image\//.test(k.mimeType)).map((k) => ({ id: k.id, name: k.name }));
  if (!imgs.length && depth < 3) {
    const sub = kids.filter((k) => k.mimeType === drive.FOLDER).sort((a, b) => collator.compare(a.name, b.name));
    for (const s of sub) {
      const inner = await listImagesRecursive(s.id, depth + 1);
      imgs.push(...inner.map((x) => ({ ...x, name: s.name + '/' + x.name })));
    }
    if (!imgs.length) {
      const zip = kids.find((k) => ZIP.test(k.name));
      if (zip) return { zip: { id: zip.id, size: Number(zip.size) } };
    }
  }
  return imgs;
}

const mimeOf = (n) => {
  const e = (n.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' }[e] || 'image/jpeg';
};

const isJunk = (n) => /(^|\/)(__MACOSX|\.)/.test(n) || /thumbs\.db$/i.test(n);

async function zipPages(id, size) {
  if (!size) size = Number((await drive.getMeta(id)).size);
  const key = 'zip:' + id + ':' + size;
  let entries = await idbGet('pages', key);
  if (!entries) {
    entries = (await readDirectory((a, b) => drive.getRange(id, a, b, true), size))
      .filter((e) => IMG.test(e.name) && !isJunk(e.name))
      .sort((a, b) => collator.compare(a.name, b.name));
    idbSet('pages', key, entries);
  }
  return entries.map((e) => ({
    name: e.name,
    load: async (priority) => {
      const fr = (a, b) => drive.getRange(id, a, b, priority);
      return new Blob([await readEntry(fr, size, e)], { type: mimeOf(e.name) });
    },
  }));
}

async function folderPages(id) {
  const key = 'folder:' + id;
  let list = await idbGet('pages', key);
  if (!list || (list.t && Date.now() - list.t > 7 * 864e5)) {
    const res = await listImagesRecursive(id);
    if (res.zip) return zipPages(res.zip.id, res.zip.size);
    list = { t: Date.now(), imgs: res.filter((x) => !isJunk(x.name)).sort((a, b) => collator.compare(a.name, b.name)) };
    if (list.imgs.length) idbSet('pages', key, list);
  }
  return list.imgs.map((x) => ({ name: x.name, load: (priority) => drive.getBlob(x.id, priority) }));
}

// Returns [{name, load(priority) -> Promise<Blob>}]
export async function loadPages(vol) {
  if (vol.type === 'unsupported') throw new Error('This file type (' + (vol.name.match(/\.\w+$/) || [''])[0] + ') cannot be opened yet.');
  let pages = [];
  try {
    pages = vol.type === 'zip' ? await zipPages(vol.id, vol.size) : await folderPages(vol.id);
  } catch (e) {
    if (e instanceof drive.AuthError || !vol.alt) throw e;
  }
  if (!pages.length && vol.alt) {
    pages = vol.alt.type === 'zip' ? await zipPages(vol.alt.id, vol.alt.size) : await folderPages(vol.alt.id);
  }
  if (!pages.length) throw new Error('No pages found in this volume.');
  return pages;
}

// ---------- Covers ----------

const coverURLs = new Map();
const coverWaits = new Map();
let coverActive = 0;
const coverQueue = [];

async function makeThumb(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = 360;
    const h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 512;
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.min(h, 720);
    const ctx = c.getContext('2d');
    // For a wide first page (a spread), show its right half: the manga cover side.
    if (img.naturalWidth > img.naturalHeight * 1.1) {
      const sw = img.naturalWidth / 2;
      c.height = Math.round((img.naturalHeight / sw) * w);
      ctx.drawImage(img, sw, 0, sw, img.naturalHeight, 0, 0, w, c.height);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
    }
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function buildCover(vol) {
  const pages = await loadPages(vol);
  const blob = await pages[0].load(false);
  return makeThumb(blob);
}

export function coverURL(vol) {
  if (coverURLs.has(vol.id)) return Promise.resolve(coverURLs.get(vol.id));
  if (coverWaits.has(vol.id)) return coverWaits.get(vol.id);
  const p = (async () => {
    let blob = await idbGet('covers', vol.id);
    if (!blob) {
      if (coverActive >= 3) await new Promise((r) => coverQueue.push(r));
      coverActive++;
      try { blob = await buildCover(vol); } finally {
        coverActive--;
        const n = coverQueue.shift();
        if (n) n();
      }
      if (blob) idbSet('covers', vol.id, blob);
    }
    const url = blob ? URL.createObjectURL(blob) : null;
    coverURLs.set(vol.id, url);
    return url;
  })();
  coverWaits.set(vol.id, p);
  p.catch(() => {}).finally(() => coverWaits.delete(vol.id));
  return p;
}
