// MichEats API — shared by the local server (server.js) and the Vercel function (api/index.js).
const crypto = require('crypto');
const { createStore } = require('./store');
const { research, exportCsv } = require('./research');

const store = createStore();
const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Manila';
const STATUSES = ['received', 'preparing', 'ready', 'completed'];
const STRANDS = ['HUMSS', 'ABM', 'STEM', 'GAS', 'TVL', 'Junior High', 'Teacher/Staff', 'Other'];

const SEED_MENU = [
  ['Chicken Adobo with Rice', 'Meals', 65, '🍗'],
  ['Pork Sisig with Rice', 'Meals', 70, '🍳'],
  ['Spaghetti', 'Meals', 45, '🍝'],
  ['Pancit Canton', 'Meals', 40, '🍜'],
  ['Silog Breakfast Plate', 'Breakfast', 80, '🍳'],
  ['Hotdog Sandwich', 'Breakfast', 35, '🌭'],
  ['Siopao', 'Snacks', 30, '🥟'],
  ['Lumpia (3 pcs)', 'Snacks', 20, '🌯'],
  ['Turon', 'Snacks', 15, '🍌'],
  ['French Fries', 'Snacks', 40, '🍟'],
  ['Bottled Water', 'Drinks', 20, '💧'],
  ['Iced Tea', 'Drinks', 20, '🧋'],
  ['Hot Chocolate', 'Drinks', 25, '☕'],
  ['Chocolate Cupcake', 'Desserts', 35, '🧁'],
  ['Ice Cream Sundae', 'Desserts', 45, '🍨'],
  ['Leche Flan', 'Desserts', 30, '🍮'],
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

// Calendar date in the canteen's timezone (Vercel servers run on UTC).
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDate = (ts = Date.now()) => dateFmt.format(new Date(ts));
const ORDERS = (date) => `orders:${date}`;

let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  const { menu } = await store.get(['menu']);
  if (!menu) {
    await store.lock(async () => {
      const again = await store.get(['menu']);
      if (again.menu) return;
      await store.set({
        menu: SEED_MENU.map(([name, category, price, emoji]) => ({
          id: crypto.randomUUID(), name, category, price, emoji, description: '', available: true,
        })),
        settings: { canteenName: 'MichEats', staffPin: process.env.STAFF_PIN || '1234', phase: 'trial' },
        meta: { seqDate: '', seqN: 0, dates: [] },
        queueLogs: [],
        timings: [],
      });
    });
  }
  seeded = true;
}

// Load `keys` under the lock, let fn change them, then write back `writeKeys`.
function mutate(keys, writeKeys, fn) {
  return store.lock(async () => {
    const data = await store.get(keys);
    const result = await fn(data);
    await store.set(Object.fromEntries(writeKeys.map((k) => [k, data[k]])));
    return result;
  });
}

async function publicState() {
  const today = localDate();
  const [version, d] = await Promise.all([store.version(), store.get(['menu', 'settings', ORDERS(today)])]);
  const { staffPin, ...settings } = d.settings || {};
  return {
    version,
    menu: d.menu || [],
    orders: d[ORDERS(today)] || [],
    settings,
    strands: STRANDS,
    serverTime: Date.now(),
  };
}

// ---------- HTTP helpers ----------

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  // Vercel pre-parses the body; the local server gives us the raw stream.
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString()) : {};
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    return req.body || {};
  }
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) fail(413, 'Request too large');
  }
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    fail(400, 'Invalid JSON');
  }
}

// ---------- routes ----------

async function route(req, res, url) {
  const method = req.method;
  const pathname = url.searchParams.get('__path') != null ? `/api/${url.searchParams.get('__path')}` : url.pathname;
  let m;

  if (method === 'GET' && pathname === '/api/state') {
    const since = url.searchParams.get('v');
    if (since) {
      const version = await store.version();
      if (String(version) === since) return send(res, 200, { unchanged: true, version, serverTime: Date.now() });
    }
    return send(res, 200, await publicState());
  }

  const { settings } = await store.get(['settings']);
  const isStaff = (req.headers['x-staff-pin'] || url.searchParams.get('pin')) === settings.staffPin;
  const requireStaff = () => isStaff || fail(401, 'Staff PIN required');

  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    return body.pin === settings.staffPin ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Wrong PIN' });
  }

  // Place an order (kiosk, phone app, or cashier walk-in)
  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    const source = ['kiosk', 'app', 'pos'].includes(body.source) ? body.source : 'kiosk';
    if (source === 'pos') requireStaff();
    const now = Date.now();
    const today = localDate(now);
    const key = ORDERS(today);
    const order = await mutate(['menu', 'meta', key], ['meta', key], (d) => {
      const items = [];
      for (const line of body.items || []) {
        const item = (d.menu || []).find((x) => x.id === line.id);
        const qty = Math.min(Math.max(parseInt(line.qty, 10) || 0, 0), 50);
        if (!item || !qty) continue;
        if (!item.available) fail(409, `${item.name} is sold out`);
        items.push({ menuId: item.id, name: item.name, price: item.price, qty });
      }
      if (!items.length) fail(400, 'Order is empty');

      const orders = d[key] || [];
      const meta = d.meta || { seqDate: '', seqN: 0, dates: [] };
      if (meta.seqDate !== today) Object.assign(meta, { seqDate: today, seqN: 0 });
      if (!meta.dates.includes(today)) meta.dates.push(today);
      const taken = new Set(orders.map((x) => x.code));

      // Customers may pick their own order number; otherwise the next free daily number is used.
      let code = String(body.code || '').trim().toUpperCase();
      let number = null;
      if (code) {
        if (!/^[A-Z0-9-]{1,8}$/.test(code)) fail(400, 'Order number can only use letters and numbers (up to 8)');
        if (taken.has(code)) fail(409, `Order number ${code} is already taken today. Choose another one.`);
      } else {
        do {
          meta.seqN += 1;
          code = String(meta.seqN).padStart(3, '0');
        } while (taken.has(code));
        number = meta.seqN;
      }

      const total = items.reduce((s, i) => s + i.price * i.qty, 0);
      const started = Number(body.startedAt);
      const o = {
        id: crypto.randomUUID(),
        number,
        code,
        date: today,
        source,
        customerId: String(body.customerId || '').trim().slice(0, 30),
        strand: STRANDS.includes(body.strand) ? body.strand : '',
        items,
        total,
        status: 'received',
        paid: false,
        startedAt: started > now - 30 * 60000 && started <= now ? started : null,
        createdAt: now,
        openAtCreate: orders.filter((x) => ['received', 'preparing', 'ready'].includes(x.status)).length,
      };
      if (source === 'pos' && body.tendered != null) {
        const tendered = Number(body.tendered);
        if (!(tendered >= total)) fail(400, 'Cash tendered is less than the total');
        Object.assign(o, { paid: true, tendered, change: tendered - total, paidAt: now });
      }
      orders.push(o);
      d[key] = orders;
      d.meta = meta;
      return o;
    });
    return send(res, 201, order);
  }

  if ((m = pathname.match(/^\/api\/orders\/([\w-]+)$/)) && method === 'GET') {
    const key = ORDERS(localDate());
    const o = ((await store.get([key]))[key] || []).find((x) => x.id === m[1]);
    return o ? send(res, 200, o) : send(res, 404, { error: 'Not found' });
  }

  if ((m = pathname.match(/^\/api\/orders\/([\w-]+)\/(status|pay)$/)) && method === 'POST') {
    requireStaff();
    const body = await readBody(req);
    const key = ORDERS(localDate());
    const o = await mutate([key], [key], (d) => {
      const order = (d[key] || []).find((x) => x.id === m[1]) || fail(404, 'Order not found');
      const now = Date.now();
      if (m[2] === 'pay') {
        if (order.paid) fail(409, 'Already paid');
        if (order.status === 'cancelled') fail(409, 'Order was cancelled');
        const tendered = Number(body.tendered);
        if (!(tendered >= order.total)) fail(400, 'Cash tendered is less than the total');
        Object.assign(order, { paid: true, tendered, change: tendered - order.total, paidAt: now });
      } else if (body.status === 'cancelled') {
        if (order.status === 'completed') fail(409, 'Order already claimed');
        Object.assign(order, { status: 'cancelled', cancelledAt: now });
      } else {
        if (!STATUSES.includes(body.status)) fail(400, 'Bad status');
        if (body.status === 'completed' && !order.paid) fail(409, 'Order must be paid before it is claimed');
        order.status = body.status;
        order[`${body.status}At`] = now;
      }
      return order;
    });
    return send(res, 200, o);
  }

  // Menu management
  if (pathname === '/api/menu' && method === 'POST') {
    requireStaff();
    const b = await readBody(req);
    const fields = {
      name: String(b.name || '').trim().slice(0, 60),
      category: String(b.category || 'Meals').trim().slice(0, 30),
      price: Math.max(0, Number(b.price) || 0),
      emoji: String(b.emoji || '🍽️').slice(0, 8),
      description: String(b.description || '').slice(0, 140),
      available: b.available !== false,
    };
    if (!fields.name) fail(400, 'Name is required');
    const item = await mutate(['menu'], ['menu'], (d) => {
      let it = b.id && d.menu.find((x) => x.id === b.id);
      if (it) Object.assign(it, fields);
      else d.menu.push((it = { id: crypto.randomUUID(), ...fields }));
      return it;
    });
    return send(res, 200, item);
  }
  if ((m = pathname.match(/^\/api\/menu\/([\w-]+)$/)) && method === 'DELETE') {
    requireStaff();
    await mutate(['menu'], ['menu'], (d) => {
      d.menu = d.menu.filter((x) => x.id !== m[1]);
    });
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && method === 'POST') {
    requireStaff();
    const b = await readBody(req);
    await mutate(['settings'], ['settings'], (d) => {
      if (b.canteenName) d.settings.canteenName = String(b.canteenName).slice(0, 40);
      if (b.phase === 'baseline' || b.phase === 'trial') d.settings.phase = b.phase;
      if (b.staffPin && /^\d{4,8}$/.test(b.staffPin)) d.settings.staffPin = b.staffPin;
    });
    return send(res, 200, { ok: true });
  }

  // Research data collection
  if (pathname === '/api/research' || pathname === '/api/export.csv') {
    requireStaff();
    const { meta } = await store.get(['meta']);
    const dateKeys = (meta?.dates || []).map(ORDERS);
    const d = await store.get(['queueLogs', 'timings', ...dateKeys]);
    const db = { orders: dateKeys.flatMap((k) => d[k] || []), queueLogs: d.queueLogs || [], timings: d.timings || [] };
    if (pathname === '/api/research') return send(res, 200, research(db));
    const type = url.searchParams.get('type') || 'orders';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="micheats-${type}-${localDate()}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end('﻿' + exportCsv(db, type, TIMEZONE));
  }

  if ((pathname === '/api/queue-logs' || pathname === '/api/timings') && method === 'POST') {
    requireStaff();
    const b = await readBody(req);
    const now = Date.now();
    const base = { id: crypto.randomUUID(), at: now, date: localDate(now), phase: settings.phase, note: String(b.note || '').slice(0, 140) };
    if (pathname === '/api/queue-logs') {
      const count = parseInt(b.count, 10);
      if (!(count >= 0)) fail(400, 'Count must be 0 or more');
      await mutate(['queueLogs'], ['queueLogs'], (d) => {
        d.queueLogs = [...(d.queueLogs || []), { ...base, count }];
      });
    } else {
      const ms = Number(b.ms);
      if (!['transaction', 'waiting'].includes(b.type) || !(ms > 0)) fail(400, 'Bad timing');
      await mutate(['timings'], ['timings'], (d) => {
        d.timings = [...(d.timings || []), { ...base, type: b.type, ms }];
      });
    }
    return send(res, 201, { ok: true });
  }
  if ((m = pathname.match(/^\/api\/(queue-logs|timings)\/([\w-]+)$/)) && method === 'DELETE') {
    requireStaff();
    const key = m[1] === 'timings' ? 'timings' : 'queueLogs';
    await mutate([key], [key], (d) => {
      d[key] = (d[key] || []).filter((x) => x.id !== m[2]);
    });
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Unknown endpoint' });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!store) {
      return send(res, 503, {
        error: 'Database not connected. In Vercel, open your project → Storage → add Upstash Redis, connect it to this project, then redeploy.',
      });
    }
    await ensureSeeded();
    await route(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message || 'Server error' });
  }
}

module.exports = { handle, store };
