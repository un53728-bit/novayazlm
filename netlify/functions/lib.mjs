// Nova Yazılım sitesi sunucu mantığı. Veri: Netlify Blobs ("arda" deposu).
import crypto from 'node:crypto';

const JSON_H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: JSON_H });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const S = (x) => (x == null ? '' : String(x));
const A = (x) => (Array.isArray(x) ? x : []);

function checkPw(pw, env) {
  const real = env.ADMIN_PASSWORD;
  if (!real) return 'no_password';
  return crypto.timingSafeEqual(sha(S(pw)), sha(real)) ? 'ok' : 'bad';
}

async function hit(store, key, max, windowMs) {
  const now = Date.now();
  let v = await store.get(key, { type: 'json' });
  if (!v || now - v.t > windowMs) v = { n: 0, t: now };
  v.n++;
  await store.setJSON(key, v);
  return v.n <= max;
}
async function peek(store, key, max, windowMs) {
  const v = await store.get(key, { type: 'json' });
  return !(v && Date.now() - v.t <= windowMs && v.n >= max);
}

/* Küfür filtresi (sitedekiyle aynı mantık) */
function nrm(t) {
  let x = S(t).toLocaleLowerCase('tr');
  const m = { 'ı': 'i', 'ğ': 'g', 'ş': 's', 'ç': 'c', 'ö': 'o', 'ü': 'u', '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '@': 'a', '$': 's' };
  x = x.replace(/[ığşçöü01345@$]/g, (c) => m[c] || c);
  x = x.replace(/[^a-z]+/g, ' ').replace(/([a-z])\1{2,}/g, '$1');
  return x.trim();
}
const BAD_EXACT = ['amk', 'amq', 'aq', 'awk', 'skrm', 'skm', 'sikik', 'orospu', 'yarrak', 'pic', 'mk'].map(nrm);
const BAD_PRE = ['sikerim', 'siktir', 'sikti', 'sikim', 'sikik', 'amina', 'anani', 'bacini', 'sulaleni', 'atani', 'allahini', 'orospu', 'yarrak', 'amcik', 'gotunu'].map(nrm);
export function isBad(text) {
  const n = nrm(text);
  if (!n) return false;
  if (/(^| )aw aw( |$)/.test(n)) return true;
  const toks = []; let run = '';
  n.split(' ').forEach((w) => { if (w.length === 1) run += w; else { if (run) { toks.push(run); run = ''; } toks.push(w); } });
  if (run) toks.push(run);
  return toks.some((t) => BAD_EXACT.includes(t) || BAD_PRE.some((p) => t.indexOf(p) === 0));
}

function publicState(st) {
  if (!st) return null;
  return { ...st, orders: [], reviews: [], log: [] };
}
async function loadState(store) { return (await store.get('state', { type: 'json' })) || null; }
async function loadData(store) {
  const d = await store.get('data', { type: 'json' });
  return d && typeof d === 'object' ? { orders: A(d.orders), reviews: A(d.reviews), exists: true } : { orders: [], reviews: [], exists: false };
}
function mergeList(client, stored, loadedAt, key) {
  const have = new Set(client.map((x) => x && x[key]));
  return client.concat(stored.filter((x) => x && !have.has(x[key]) && (+x.at || 0) > loadedAt));
}
async function notify(env, text) {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1800) }), signal: AbortSignal.timeout(3000) });
  } catch (e) { /* bildirim başarısızsa sipariş yine kaydedilir */ }
}
async function body(req) {
  const t = await req.text();
  if (t.length > 5800000) throw Object.assign(new Error('big'), { code: 'too_large' });
  try { return JSON.parse(t || '{}'); } catch (e) { throw Object.assign(new Error('json'), { code: 'bad_json' }); }
}

export async function handle(req, store, env, ip) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const who = crypto.createHash('sha256').update('arda|' + S(ip || 'x')).digest('hex').slice(0, 24);
  try {
    if (req.method === 'GET' && route === 'state') {
      const st = await loadState(store), d = await loadData(store);
      return J(200, { state: publicState(st), reviews: d.reviews.filter((r) => r && !r.pending), dataExists: d.exists });
    }
    if (req.method === 'GET' && route === 'track') {
      if (!(await hit(store, 'rl-track-' + who, 60, 60000))) return J(429, { code: 'rate_limited' });
      const code = S(url.searchParams.get('code')).trim().toUpperCase().replace(/^#/, '');
      const d = await loadData(store);
      const o = d.orders.find((x) => x && S(x.oid).toUpperCase() === code);
      if (!o) return J(200, { found: false });
      return J(200, { found: true, oid: o.oid, plan: o.plan, price: o.price, at: o.at, status: o.status });
    }
    if (req.method !== 'POST') return J(404, { code: 'not_found' });

    if (route === 'order') {
      if (!(await hit(store, 'rl-order-' + who, 6, 3600000))) return J(429, { code: 'rate_limited' });
      const b = await body(req), o = b.order || {};
      const plan = S(o.plan).trim().slice(0, 80), ig = S(o.ig).trim().replace(/^@/, '');
      const price = S(o.price).trim().slice(0, 30), code = S(o.code).trim().slice(0, 30), uid = /^\d{4}$/.test(S(o.uid)) ? S(o.uid) : '';
      if (!plan || !/^[A-Za-z0-9._]{2,40}$/.test(ig)) return J(400, { code: 'invalid' });
      const d = await loadData(store);
      if (d.orders.length >= 2000) return J(503, { code: 'full' });
      let oid; const used = new Set(d.orders.map((x) => x && x.oid));
      do { oid = 'S' + (10000 + crypto.randomInt(90000)); } while (used.has(oid));
      const order = { oid, uid, plan, ig, price, code, status: 'gonderildi', at: Date.now() };
      d.orders.push(order);
      await store.setJSON('data', { orders: d.orders, reviews: d.reviews });
      await notify(env, `Yeni sipariş ${oid}\n${plan} · ${price}${code ? ' · kod: ' + code : ''}\nInstagram: @${ig}${uid ? '\nÜye #' + uid : ''}`);
      return J(200, { ok: true, oid });
    }

    if (route === 'member') {
      if (!(await hit(store, 'rl-member-' + who, 30, 3600000))) return J(429, { code: 'rate_limited' });
      const b = await body(req), m = b.m || {};
      const id = S(m.id), email = S(m.email).trim().toLowerCase().slice(0, 120), name = S(m.name).trim().slice(0, 24);
      if (!/^\d{4}$/.test(id) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 2) return J(400, { code: 'invalid' });
      const users = (await store.get('users', { type: 'json' })) || {};
      if (!users[id]) {
        if (Object.keys(users).length >= 5000) return J(503, { code: 'full' });
        users[id] = { id, name, email, at: Math.min(+m.at || Date.now(), Date.now()) };
        await store.setJSON('users', users);
      } else if (users[id].email === email && users[id].name !== name) {
        users[id].name = name;
        await store.setJSON('users', users);
      }
      return J(200, { ok: true });
    }

    if (route === 'review') {
      if (!(await peek(store, 'mute-' + who, 1, 3600000))) return J(429, { code: 'muted' });
      if (!(await hit(store, 'rl-review-' + who, 5, 3600000))) return J(429, { code: 'rate_limited' });
      const b = await body(req), r = b.review || {};
      const name = S(r.name).trim().slice(0, 40), text = S(r.text).replace(/\s*\n+\s*/g, ' ').trim().slice(0, 400);
      const stars = Math.max(1, Math.min(5, parseInt(r.stars, 10) || 5));
      if (name.length < 2 || text.length < 3) return J(400, { code: 'invalid' });
      if (isBad(name) || isBad(text)) {
        await store.setJSON('mute-' + who, { n: 1, t: Date.now() });
        return J(403, { code: 'profanity' });
      }
      const d = await loadData(store);
      if (d.reviews.filter((x) => x && x.pending).length >= 200) return J(503, { code: 'full' });
      const rev = { id: String(Date.now()) + String(crypto.randomInt(1000)), name, text, stars, at: Date.now(), pending: true, uid: /^\d{4}$/.test(S(r.uid)) ? S(r.uid) : '' };
      d.reviews.push(rev);
      await store.setJSON('data', { orders: d.orders, reviews: d.reviews });
      await notify(env, `Yeni yorum (onay bekliyor)\n${name} · ${stars}/5\n${text}`);
      return J(200, { ok: true });
    }

    if (route.indexOf('admin/') === 0) {
      if (!(await peek(store, 'bf-' + who, 6, 600000))) return J(429, { code: 'rate_limited' });
      const b = await body(req), ok = checkPw(b.pw, env);
      if (ok === 'no_password') return J(503, { code: 'no_password' });
      if (ok !== 'ok') { await hit(store, 'bf-' + who, 6, 600000); return J(401, { code: 'unauthorized' }); }
      if (route === 'admin/login') return J(200, { ok: true });
      if (route === 'admin/users') {
        const users = (await store.get('users', { type: 'json' })) || {};
        return J(200, { users: Object.values(users) });
      }
      if (route === 'admin/state') {
        const st = await loadState(store), d = await loadData(store);
        return J(200, { state: st ? { ...st, orders: d.orders, reviews: d.reviews } : null, data: d, loadedAt: Date.now() });
      }
      if (route === 'admin/publish') {
        const next = b.state;
        if (!next || typeof next !== 'object' || Array.isArray(next)) return J(400, { code: 'invalid' });
        const cur = await loadState(store);
        if (cur && +cur.rev !== (+next.rev || 0) - 1) return J(409, { code: 'conflict' });
        const loadedAt = +b.loadedAt || 0, d = await loadData(store);
        const orders = mergeList(A(next.orders), d.orders, loadedAt, 'oid').slice(-2000);
        const reviews = mergeList(A(next.reviews), d.reviews, loadedAt, 'id').slice(-400);
        const clean = { ...next }; delete clean.orders; delete clean.reviews;
        await store.setJSON('state', clean);
        await store.setJSON('data', { orders, reviews });
        return J(200, { ok: true, rev: clean.rev });
      }
    }
    return J(404, { code: 'not_found' });
  } catch (e) {
    if (e && e.code === 'too_large') return J(413, { code: 'too_large' });
    if (e && e.code === 'bad_json') return J(400, { code: 'bad_json' });
    return J(500, { code: 'server_error' });
  }
}
