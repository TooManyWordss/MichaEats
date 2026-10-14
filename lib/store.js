// Key-value storage with two interchangeable backends:
//  - Upstash Redis (REST) when KV_REST_API_URL / UPSTASH_REDIS_REST_URL is set — used on Vercel
//  - a local JSON file otherwise — used by `npm start`
// Interface: version(), get(keys), set(entries) (also bumps version), lock(fn), flush().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function redisStore(url, token) {
  const base = url.replace(/\/$/, '');
  const P = 'micheats:';
  const headers = { Authorization: `Bearer ${token}` };

  async function call(cmd) {
    const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(cmd) });
    const json = await res.json();
    if (json.error) throw new Error(`Database error: ${json.error}`);
    return json.result;
  }
  async function pipeline(cmds) {
    const res = await fetch(`${base}/pipeline`, { method: 'POST', headers, body: JSON.stringify(cmds) });
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error(`Database error: ${json.error || 'bad response'}`);
    for (const r of json) if (r.error) throw new Error(`Database error: ${r.error}`);
    return json.map((r) => r.result);
  }

  return {
    kind: 'redis',
    async version() {
      return Number(await call(['GET', `${P}version`])) || 0;
    },
    async get(keys) {
      if (!keys.length) return {};
      const vals = await call(['MGET', ...keys.map((k) => P + k)]);
      return Object.fromEntries(keys.map((k, i) => [k, vals[i] == null ? null : JSON.parse(vals[i])]));
    },
    async set(entries) {
      const cmds = Object.entries(entries).map(([k, v]) => ['SET', P + k, JSON.stringify(v)]);
      cmds.push(['INCR', `${P}version`]);
      await pipeline(cmds);
    },
    // Simple distributed lock so two devices ordering at the same instant can't overwrite each other.
    async lock(fn) {
      const token = crypto.randomUUID();
      const deadline = Date.now() + 8000;
      while ((await call(['SET', `${P}lock`, token, 'NX', 'PX', '10000'])) !== 'OK') {
        if (Date.now() > deadline) throw new Error('Server busy, please try again');
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
      }
      try {
        return await fn();
      } finally {
        await call(['EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", '1', `${P}lock`, token]).catch(() => {});
      }
    },
    flush() {},
  };
}

// Converts the first version's single-object db.json into the key-value layout.
function migrate(old) {
  if (!old || !Array.isArray(old.menu)) return { version: 0, parts: {} };
  const parts = {
    menu: old.menu,
    settings: old.settings,
    queueLogs: old.queueLogs || [],
    timings: old.timings || [],
    meta: { seqDate: old.seq?.date || '', seqN: old.seq?.n || 0, dates: [] },
  };
  for (const o of old.orders || []) {
    (parts[`orders:${o.date}`] ||= []).push(o);
    if (!parts.meta.dates.includes(o.date)) parts.meta.dates.push(o.date);
  }
  return { version: 1, parts };
}

function fileStore(file) {
  let data = { version: 0, parts: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = raw.parts ? raw : migrate(raw);
  } catch { /* first run */ }

  let timer = null;
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1));
    fs.renameSync(`${file}.tmp`, file);
  };
  let chain = Promise.resolve();

  return {
    kind: 'file',
    async version() {
      return data.version;
    },
    async get(keys) {
      return Object.fromEntries(keys.map((k) => [k, data.parts[k] === undefined ? null : structuredClone(data.parts[k])]));
    },
    async set(entries) {
      for (const [k, v] of Object.entries(entries)) data.parts[k] = structuredClone(v);
      data.version += 1;
      clearTimeout(timer);
      timer = setTimeout(write, 150);
    },
    lock(fn) {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        write();
      }
    },
  };
}

function createStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url, token);
  // Vercel's filesystem is read-only and not shared between requests, so a database is required there.
  if (process.env.VERCEL) return null;
  return fileStore(path.join(__dirname, '..', 'data', 'db.json'));
}

module.exports = { createStore };
