// Google OAuth 2.0 implicit (redirect) flow. Works in Safari and in a
// Home Screen web app, where popups are unreliable. Read-only Drive scope.

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_KEY = 'mr.token';

function ls(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { return null; }
}

export function getClientId() {
  return (window.MR_CONFIG && window.MR_CONFIG.clientId) || ls('mr.clientId') || '';
}
export function setClientId(id) { ls('mr.clientId', (id || '').trim() || null); }

export function redirectUri() { return location.origin + location.pathname; }

// Call before routing. Returns {ok:true} after a successful sign-in redirect,
// {error} after a failed one, or null when the URL is not an OAuth response.
export function handleRedirect() {
  const h = location.hash || '';
  if (!/(^#|&)(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h.slice(1));
  const expected = ls('mr.oauthState');
  const ret = ls('mr.returnTo') || '#/';
  ls('mr.oauthState', null);
  ls('mr.returnTo', null);
  history.replaceState(null, '', location.pathname + location.search + ret);
  if (p.get('error')) return { error: p.get('error') };
  if (expected && p.get('state') !== expected) return { error: 'state_mismatch' };
  const exp = Number(p.get('expires_in')) || 3600;
  ls(TOKEN_KEY, JSON.stringify({ token: p.get('access_token'), exp: Date.now() + (exp - 120) * 1000 }));
  return { ok: true };
}

export function token() {
  try {
    const t = JSON.parse(ls(TOKEN_KEY) || 'null');
    if (t && t.token && t.exp > Date.now()) return t.token;
  } catch {}
  return null;
}
export function tokenMinutesLeft() {
  try { const t = JSON.parse(ls(TOKEN_KEY) || 'null'); return t ? (t.exp - Date.now()) / 60000 : 0; } catch { return 0; }
}
export function clearToken() { ls(TOKEN_KEY, null); }

export function signIn(returnTo) {
  const clientId = getClientId();
  if (!clientId) { location.hash = '#/setup'; return; }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  ls('mr.oauthState', state);
  ls('mr.returnTo', returnTo || location.hash || '#/');
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  const hint = ls('mr.email');
  if (hint) q.set('login_hint', hint);
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

export function signOut() {
  const t = token();
  clearToken();
  ls('mr.email', null);
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => {});
}
