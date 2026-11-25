// Minimal read-only Google Drive v3 client.
import { token, clearToken } from './auth.js';

const API = (window.MR_CONFIG && window.MR_CONFIG.apiBase) || 'https://www.googleapis.com/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';

export class AuthError extends Error { constructor() { super('auth'); this.name = 'AuthError'; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, headers = {}, tries = 4) {
  for (let i = 0; ; i++) {
    const t = token();
    if (!t) throw new AuthError();
    let r;
    try {
      r = await fetch(url, { headers: { ...headers, Authorization: 'Bearer ' + t } });
    } catch (e) {
      if (i < tries) { await sleep(500 * 2 ** i); continue; }
      throw e;
    }
    if (r.status === 401) { clearToken(); throw new AuthError(); }
    if (r.ok) return r;
    if ((r.status === 429 || r.status >= 500 || r.status === 403) && i < tries) {
      await sleep(700 * 2 ** i + Math.random() * 300);
      continue;
    }
    throw new Error('Drive error ' + r.status);
  }
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function listQuery(query, fields = 'id,name,mimeType,size,createdTime,modifiedTime') {
  const out = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({
      q: query,
      fields: `nextPageToken,files(${fields})`,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await req(`${API}/files?${p}`);
    const j = await r.json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

export const listChildren = (id) => listQuery(`'${q(id)}' in parents and trashed=false`);

export async function findFolder(name) {
  const res = await listQuery(`name='${q(name)}' and mimeType='${FOLDER}' and trashed=false`, 'id,name,parents');
  return res[0] || null;
}

export async function aboutEmail() {
  try {
    const r = await req(`${API}/about?fields=user(emailAddress)`);
    return (await r.json()).user?.emailAddress || '';
  } catch { return ''; }
}

export async function getMeta(id) {
  const r = await req(`${API}/files/${id}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`);
  return r.json();
}

// Limit simultaneous media downloads so page turns are not starved by covers.
let active = 0;
const waiting = [];
async function slot(fn, priority) {
  if (active >= 4) await new Promise((res) => (priority ? waiting.unshift(res) : waiting.push(res)));
  active++;
  try { return await fn(); } finally {
    active--;
    const n = waiting.shift();
    if (n) n();
  }
}

export function getBlob(id, priority = false) {
  return slot(async () => {
    const r = await req(`${API}/files/${id}?alt=media&supportsAllDrives=true`);
    return r.blob();
  }, priority);
}

// Inclusive byte range.
export function getRange(id, start, end, priority = false) {
  return slot(async () => {
    const r = await req(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { Range: `bytes=${start}-${end}` });
    const buf = new Uint8Array(await r.arrayBuffer());
    // A server that ignores Range returns the whole file with 200.
    if (r.status === 200 && buf.length > end - start + 1) return buf.subarray(start, end + 1);
    return buf;
  }, priority);
}
