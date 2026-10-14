// Statistics for the study (SOP 2.1–2.3) and CSV export.

// ---------- statistics ----------

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function summary(a) {
  return { n: a.length, mean: mean(a), sd: sd(a), min: a.length ? Math.min(...a) : null, max: a.length ? Math.max(...a) : null };
}

// Regularized incomplete beta (Numerical Recipes) for the Student-t p-value.
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  const EPS = 3e-12, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// Welch's two-sample t-test (unequal variances), two-tailed.
function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length;
  if (va + vb === 0) return null;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const p = ibeta(df / (df + t * t), df / 2, 0.5);
  return { t, df, p, significant: p < 0.05 };
}

const minutes = (ms) => ms / 60000;

function research(db) {
  const orders = db.orders.filter((o) => o.status !== 'cancelled');
  const digital = orders.filter((o) => o.source === 'kiosk' || o.source === 'app');

  // System-measured metrics (automatically logged by the kiosk / app during the trial)
  const sysTx = (list) => list.filter((o) => o.startedAt).map((o) => minutes(o.createdAt - o.startedAt));
  const sysWaitReady = (list) => list.filter((o) => o.readyAt).map((o) => minutes(o.readyAt - o.createdAt));
  const sysWaitClaim = (list) => list.filter((o) => o.completedAt).map((o) => minutes(o.completedAt - o.createdAt));
  const sysQueue = (list) => list.map((o) => o.openAtCreate ?? 0);

  const dates = [...new Set(orders.map((o) => o.date))].sort();
  const byDay = dates.map((date) => {
    const d = digital.filter((o) => o.date === date);
    const all = orders.filter((o) => o.date === date);
    const strands = {};
    for (const o of all) strands[o.strand || 'Unspecified'] = (strands[o.strand || 'Unspecified'] || 0) + 1;
    const q = db.queueLogs.filter((l) => l.date === date && l.phase === 'trial').map((l) => l.count);
    return {
      date,
      orders: all.length,
      bySource: {
        kiosk: all.filter((o) => o.source === 'kiosk').length,
        app: all.filter((o) => o.source === 'app').length,
        pos: all.filter((o) => o.source === 'pos').length,
      },
      strands,
      sales: all.filter((o) => o.paid).reduce((s, o) => s + o.total, 0),
      transaction: summary(sysTx(d)),
      waitReady: summary(sysWaitReady(all)),
      waitClaim: summary(sysWaitClaim(all)),
      openOrders: summary(sysQueue(all)),
      observedQueue: summary(q),
    };
  });

  // Before-vs-during comparison uses the researchers' own observations (same method in both phases).
  const obs = (phase, type) => db.timings.filter((t) => t.phase === phase && t.type === type).map((t) => minutes(t.ms));
  const queue = (phase) => db.queueLogs.filter((l) => l.phase === phase).map((l) => l.count);
  const compare = (b, t) => ({ baseline: summary(b), trial: summary(t), test: welch(b, t) });

  return {
    comparison: {
      queueLength: compare(queue('baseline'), queue('trial')),
      transaction: compare(obs('baseline', 'transaction'), obs('trial', 'transaction')),
      waiting: compare(obs('baseline', 'waiting'), obs('trial', 'waiting')),
    },
    system: {
      transaction: summary(sysTx(digital)),
      waitReady: summary(sysWaitReady(orders)),
      waitClaim: summary(sysWaitClaim(orders)),
      openOrders: summary(sysQueue(orders)),
    },
    byDay,
    queueLogs: db.queueLogs.slice(-50).reverse(),
    timings: db.timings.slice(-50).reverse(),
  };
}

// ---------- CSV ----------

function csv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
const iso = (ts, timeZone) => (ts ? new Date(ts).toLocaleString('en-PH', { hour12: false, timeZone }) : '');
const mins = (a, b) => (a && b ? minutes(b - a).toFixed(2) : '');

function exportCsv(db, type, tz) {
  if (type === 'queue') {
    return csv([['date', 'time', 'phase', 'queue_length', 'note'],
      ...db.queueLogs.map((l) => [l.date, iso(l.at, tz), l.phase, l.count, l.note])]);
  }
  if (type === 'timings') {
    return csv([['date', 'time', 'phase', 'measure', 'minutes', 'note'],
      ...db.timings.map((t) => [t.date, iso(t.at, tz), t.phase, t.type, minutes(t.ms).toFixed(2), t.note])]);
  }
  return csv([[
    'date', 'order_no', 'source', 'strand', 'items', 'total', 'status', 'paid',
    'started', 'placed', 'preparing', 'ready', 'paid_at', 'claimed',
    'transaction_min', 'wait_to_ready_min', 'wait_to_claim_min', 'open_orders_at_placement',
  ], ...db.orders.map((o) => [
    o.date, o.code, o.source, o.strand, o.items.map((i) => `${i.qty}x ${i.name}`).join('; '), o.total, o.status, o.paid ? 'yes' : 'no',
    iso(o.startedAt, tz), iso(o.createdAt, tz), iso(o.preparingAt, tz), iso(o.readyAt, tz), iso(o.paidAt, tz), iso(o.completedAt, tz),
    mins(o.startedAt, o.createdAt), mins(o.createdAt, o.readyAt), mins(o.createdAt, o.completedAt), o.openAtCreate,
  ])]);
}

module.exports = { research, exportCsv };
