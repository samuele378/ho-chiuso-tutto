// ═══════════════════════════════════════════════════════════════════════
//  Ho Chiuso Tutto? — check-events
//  Netlify Scheduled Function (ogni minuto, vedi netlify.toml)
//
//  1. Legge gli impegni da Firebase Realtime Database (REST)
//  2. Trova quelli in scadenza nei minuti appena passati (finestra di recupero)
//  3. Manda una push FCM (HTTP v1) a tutti i telefoni registrati
//  4. Gestisce le "prove notifica" richieste dall'app
//
//  Zero dipendenze npm: usa solo fetch + crypto di Node.
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const PROJECT_ID = 'calendario-e26e8';
const DB_URL = 'https://calendario-e26e8-default-rtdb.firebaseio.com';
const FCM_URL = 'https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.messaging',
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const MAX_CATCHUP_MIN = 5;   // se il cron salta qualche minuto, recupera al massimo questi
const PUSH_TTL_SEC = '600';  // se il telefono è offline, la notifica scade dopo 10 minuti
const FREQ_LABELS = { day: 'Ogni giorno', week: 'Ogni settimana', month: 'Ogni mese', year: 'Ogni anno' };

// ── Service account + OAuth2 ──────────────────────────────────────────
let cachedToken = null; // { token, exp }

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Variabile FIREBASE_SERVICE_ACCOUNT mancante su Netlify');
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT non è un JSON valido (incollato male o troncato)'); }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT incompleto (manca client_email o private_key)');
  sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
  return sa;
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 120 > now) return cachedToken.token;
  const sa = loadServiceAccount();
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const signature = signer.sign(sa.private_key, 'base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = header + '.' + claims + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error('OAuth Google fallito: ' + JSON.stringify(json));
  cachedToken = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return cachedToken.token;
}

// ── Realtime Database REST ────────────────────────────────────────────
async function dbRequest(method, path, token, body, query) {
  const url = DB_URL + '/' + path + '.json' + (query ? '?' + query : '');
  const res = await fetch(url, {
    method: method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error('RTDB ' + method + ' /' + path + ' → ' + res.status + ' ' + (await res.text()).slice(0, 200));
  if (method === 'DELETE') return null;
  return res.json();
}
const dbGet = (path, token, query) => dbRequest('GET', path, token, undefined, query);
const dbPut = (path, value, token) => dbRequest('PUT', path, token, value);
const dbDelete = (path, token) => dbRequest('DELETE', path, token);

// ── Ora di Roma ───────────────────────────────────────────────────────
const romeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function romeParts(date) {
  const p = {};
  romeFmt.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  return { dateStr: p.year + '-' + p.month + '-' + p.day, timeStr: p.hour + ':' + p.minute };
}

// ── Stesse regole di getEventsForDate() dell'app ──────────────────────
function eventMatchesDate(ev, dateStr) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'once') return ev.date === dateStr;
  if (ev.type === 'recurring') {
    if (!ev.created || dateStr < ev.created) return false;
    const d = new Date(dateStr + 'T00:00:00Z');
    const c = new Date(ev.created + 'T00:00:00Z');
    if (ev.freq === 'day') return true;
    if (ev.freq === 'week') return d.getUTCDay() === c.getUTCDay();
    if (ev.freq === 'month') return d.getUTCDate() === c.getUTCDate();
    if (ev.freq === 'year') return d.getUTCDate() === c.getUTCDate() && d.getUTCMonth() === c.getUTCMonth();
  }
  return false;
}

function buildMessage(ev, dateStr, timeStr) {
  const sub = ev.type === 'recurring' ? (FREQ_LABELS[ev.freq] || 'Ricorrente') : 'Adesso!';
  return {
    title: (ev.icon || '📌') + ' ' + (ev.name || 'Impegno'),
    body: sub + ' · ore ' + timeStr,
    tag: 'hct-' + ev.id + '-' + dateStr.replace(/-/g, '') + '-' + timeStr.replace(':', '')
  };
}

// ── FCM HTTP v1 ───────────────────────────────────────────────────────
async function sendPush(accessToken, fcmToken, msg) {
  const payload = {
    message: {
      token: fcmToken,
      data: { title: String(msg.title), body: String(msg.body), tag: String(msg.tag) },
      webpush: { headers: { Urgency: 'high', TTL: PUSH_TTL_SEC } }
    }
  };
  const res = await fetch(FCM_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) return { ok: true };
  const j = await res.json().catch(() => ({}));
  let code = (j.error && j.error.status) || String(res.status);
  if (j.error && Array.isArray(j.error.details)) {
    const d = j.error.details.find(x => x.errorCode);
    if (d) code = d.errorCode;
  }
  // Token non più valido (app disinstallata, permesso revocato, iscrizione cambiata)
  const invalid = res.status === 404 || code === 'UNREGISTERED';
  return { ok: false, status: res.status, code: code, invalid: invalid, detail: (j.error && j.error.message) || '' };
}

function tokenList(tokensNode) {
  const out = [];
  if (!tokensNode || typeof tokensNode !== 'object') return out;
  for (const [key, val] of Object.entries(tokensNode)) {
    const t = typeof val === 'string' ? val : (val && val.token);
    if (t) out.push({ key: key, token: t });
  }
  return out;
}

async function broadcast(accessToken, tokens, msg, stats) {
  for (const t of tokens) {
    if (t.invalid) continue; // già riconosciuto morto in questo giro
    try {
      const r = await sendPush(accessToken, t.token, msg);
      if (r.ok) { stats.sent++; continue; }
      stats.failed++;
      console.warn('[check-events] FCM errore', r.status, r.code, r.detail, 'token', t.key);
      if (r.invalid) {
        t.invalid = true;
        await dbDelete('tokens/' + t.key, accessToken).catch(() => {});
        stats.removedTokens++;
      }
    } catch (e) {
      stats.failed++;
      console.warn('[check-events] FCM eccezione', e.message);
    }
  }
}

// ── Handler ───────────────────────────────────────────────────────────
exports.handler = async function () {
  const stats = { sent: 0, failed: 0, removedTokens: 0, due: 0, tests: 0, slots: 0 };
  const nowMs = Date.now();
  const nowMin = Math.floor(nowMs / 60000);
  const nowRome = romeParts(new Date(nowMs));

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error('[check-events] ' + e.message);
    return { statusCode: 500, body: e.message };
  }

  try {
    const [events, tokensNode, meta, tests] = await Promise.all([
      dbGet('events', accessToken),
      dbGet('tokens', accessToken),
      dbGet('meta', accessToken),
      dbGet('test', accessToken)
    ]);
    const tokens = tokenList(tokensNode);

    // ── Prove notifica richieste dall'app ──
    if (tests && typeof tests === 'object') {
      for (const [key, val] of Object.entries(tests)) {
        const t = typeof val === 'string' ? val : (val && val.token);
        await dbDelete('test/' + key, accessToken).catch(() => {});
        if (!t) continue;
        stats.tests++;
        await broadcast(accessToken, [{ key: key, token: t }], {
          title: '🧪 Prova riuscita!',
          body: 'Le notifiche funzionano anche con l\'app chiusa · ' + nowRome.timeStr,
          tag: 'hct-test-' + nowMs
        }, stats);
      }
    }

    // ── Finestra dei minuti da controllare (recupera eventuali minuti saltati) ──
    let lastMin = meta && Number(meta.lastMinute);
    if (!lastMin || !isFinite(lastMin)) lastMin = nowMin - 1;
    lastMin = Math.max(lastMin, nowMin - MAX_CATCHUP_MIN);
    const slots = [];
    for (let m = lastMin + 1; m <= nowMin; m++) slots.push(m);
    stats.slots = slots.length;

    const eventList = events && typeof events === 'object' ? Object.values(events) : [];
    const sentCache = {}; // dateStr -> markers già inviati

    for (const m of slots) {
      const { dateStr, timeStr } = romeParts(new Date(m * 60000));
      if (!sentCache[dateStr]) sentCache[dateStr] = (await dbGet('sent/' + dateStr, accessToken)) || {};
      for (const ev of eventList) {
        if (!ev || ev.time !== timeStr || !eventMatchesDate(ev, dateStr)) continue;
        const marker = String(ev.id) + '_' + timeStr.replace(':', '');
        if (sentCache[dateStr][marker]) continue;
        stats.due++;
        if (tokens.length > 0) {
          await broadcast(accessToken, tokens, buildMessage(ev, dateStr, timeStr), stats);
        }
        sentCache[dateStr][marker] = true;
        await dbPut('sent/' + dateStr + '/' + marker, nowMs, accessToken).catch(() => {});
      }
    }

    await dbPut('meta', { lastMinute: nowMin, lastRun: nowRome.dateStr + ' ' + nowRome.timeStr, tokens: tokens.length, events: eventList.length }, accessToken);

    // ── Pulizia marker vecchi (una volta all'ora) ──
    if (nowMin % 60 === 0) {
      const days = await dbGet('sent', accessToken, 'shallow=true').catch(() => null);
      if (days && typeof days === 'object') {
        const yesterday = romeParts(new Date(nowMs - 86400000)).dateStr;
        for (const d of Object.keys(days)) {
          if (d < yesterday) await dbDelete('sent/' + d, accessToken).catch(() => {});
        }
      }
    }

    const line = '[check-events] ' + nowRome.dateStr + ' ' + nowRome.timeStr + ' Roma | minuti=' + stats.slots +
      ' | eventi=' + eventList.length + ' | in scadenza=' + stats.due + ' | telefoni=' + tokens.length +
      ' | inviate=' + stats.sent + ' | fallite=' + stats.failed + ' | prove=' + stats.tests;
    console.log(line);
    return { statusCode: 200, body: JSON.stringify(stats) };

  } catch (e) {
    console.error('[check-events] errore:', e.message);
    return { statusCode: 500, body: e.message };
  }
};
