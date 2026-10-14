'use strict';
// MichEats — single-page client for every screen: kiosk, phone ordering, tracking,
// cashier POS, preparation (kitchen) display, public display, and admin/research.

const S = {
  state: null,
  offset: 0,
  pin: sessionStorage.getItem('pin') || '',
  view: null,
  route: '',
  sound: false,
  online: false,
  lastInteract: Date.now(),
};
const app = document.getElementById('app');

// ---------- helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const now = () => Date.now() + S.offset;
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const STATUS_LABEL = { received: 'Order received', preparing: 'Preparing', ready: 'Ready for pickup', completed: 'Claimed', cancelled: 'Cancelled' };
const STATUS_BADGE = { received: 'blue', preparing: 'warn', ready: 'ok', completed: '', cancelled: 'danger' };
const SOURCE_LABEL = { kiosk: 'Kiosk', app: 'Phone app', pos: 'Cashier' };
const statusBadge = (o) => `<span class="badge ${STATUS_BADGE[o.status]}">${STATUS_LABEL[o.status]}</span>`;
const payBadge = (o) => (o.paid ? '<span class="badge ok">Paid</span>' : '<span class="badge danger">Unpaid</span>');
const todayOrders = () => (S.state ? S.state.orders : []);
const findOrder = (id) => todayOrders().find((o) => o.id === id);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-staff-pin': S.pin },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && S.view && S.view.staff) {
    S.pin = '';
    sessionStorage.removeItem('pin');
    render();
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  if (method !== 'GET') setTimeout(poll, 0); // show the change on this screen right away
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

let actx;
function beep(freq = 880, dur = 0.15, times = 2) {
  if (!S.sound) return;
  try {
    actx = actx || new AudioContext();
    for (let i = 0; i < times; i++) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.value = freq;
      o.connect(g);
      g.connect(actx.destination);
      const t = actx.currentTime + i * (dur + 0.08);
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t);
      o.stop(t + dur);
    }
  } catch { /* audio unavailable */ }
}
function say(text) {
  if (!S.sound || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  speechSynthesis.speak(u);
}
const soundBtn = () => `<button class="btn sm" data-act="sound">${S.sound ? '🔔 Sound on' : '🔕 Enable sound'}</button>`;

function printReceipt(o) {
  const r = document.getElementById('receipt');
  r.innerHTML = `
    <h2>${esc(S.state.settings.canteenName)}</h2>
    <div style="text-align:center">School Canteen</div><hr>
    <div style="text-align:center">ORDER NO.</div>
    <div class="big">${o.code}</div>
    <div style="text-align:center">${new Date(o.createdAt).toLocaleString()}</div><hr>
    <table>${o.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td class="r">${peso(i.qty * i.price)}</td></tr>`).join('')}</table><hr>
    <table>
      <tr><td><b>TOTAL</b></td><td class="r"><b>${peso(o.total)}</b></td></tr>
      ${o.paid
        ? `<tr><td>Cash</td><td class="r">${peso(o.tendered)}</td></tr><tr><td>Change</td><td class="r">${peso(o.change)}</td></tr>`
        : '<tr><td colspan="2"><b>UNPAID — please pay at the cashier</b></td></tr>'}
    </table><hr>
    <div style="text-align:center">Watch the display for your number.<br>Thank you!</div>`;
  window.print();
}

// ---------- rendering ----------

function preserve(fn) {
  const a = document.activeElement;
  const id = a && a.id;
  let sel = null;
  try { if (id) sel = [a.selectionStart, a.selectionEnd]; } catch { /* not a text input */ }
  const scrolls = [...app.querySelectorAll('[id]')].filter((e) => e.scrollTop).map((e) => [e.id, e.scrollTop]);
  fn();
  for (const [i, t] of scrolls) {
    const e = document.getElementById(i);
    if (e) e.scrollTop = t;
  }
  if (id) {
    const e = document.getElementById(id);
    if (e) {
      e.focus();
      try { if (sel && sel[0] != null) e.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ }
    }
  }
}

function render() {
  const v = S.view;
  if (!v) return;
  if (v.staff && !S.pin) {
    app.innerHTML = pinGate();
    document.getElementById('pin')?.focus();
    return;
  }
  if (!S.state) {
    app.innerHTML = `<div class="empty">${S.error ? `⚠️ ${esc(S.error)}` : 'Connecting to the canteen server…'}</div>`;
    return;
  }
  preserve(() => (app.innerHTML = v.render()));
}

function pinGate() {
  return `
    <form class="card pin-box stack" data-submit="login">
      <div style="font-size:36px">🔒</div>
      <h2>Staff access</h2>
      <p class="muted">Enter the canteen staff PIN to open this screen.</p>
      <input id="pin" class="input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required>
      <button class="btn primary block">Unlock</button>
      <a href="#/" class="muted">← Back</a>
    </form>`;
}

const globalActions = {
  async login(d, form) {
    const pin = form.querySelector('#pin').value;
    try {
      await api('/api/login', { method: 'POST', body: { pin } });
      S.pin = pin;
      sessionStorage.setItem('pin', pin);
      render();
      S.view.enter?.();
    } catch (e) {
      toast(e.message, true);
    }
  },
  sound() {
    S.sound = !S.sound;
    try {
      actx = actx || new AudioContext();
      actx.resume();
    } catch { /* ignore */ }
    beep(990, 0.1, 1);
    render();
  },
  exit() {
    // Triple-tap the top-left corner to leave kiosk / display mode.
    const t = Date.now();
    S.exitTaps = (S.exitTaps || []).filter((x) => t - x < 1500).concat(t);
    if (S.exitTaps.length >= 3) location.hash = '#/';
  },
};

app.addEventListener('click', (e) => {
  S.lastInteract = Date.now();
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const fn = (S.view.actions && S.view.actions[t.dataset.act]) || globalActions[t.dataset.act];
  if (fn) fn(t.dataset, t, e);
});
app.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = e.target.dataset.submit;
  const fn = (S.view.actions && S.view.actions[name]) || globalActions[name];
  if (fn) fn(e.target.dataset, e.target, e);
});
app.addEventListener('input', (e) => {
  S.lastInteract = Date.now();
  const key = e.target.dataset.bind;
  if (!key || !S.view.data) return;
  S.view.data[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  S.view.onBind?.(key);
});

setInterval(() => {
  const n = now();
  document.querySelectorAll('[data-since]').forEach((el) => {
    const ms = n - Number(el.dataset.since);
    el.textContent = mmss(ms);
    if (el.dataset.late) el.closest('.ticket')?.classList.toggle('late', ms > el.dataset.late * 60000);
  });
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    el.textContent = Math.max(0, Math.ceil((Number(el.dataset.countdown) - Date.now()) / 1000));
  });
  document.querySelectorAll('[data-clock]').forEach((el) => {
    el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });
  S.view?.tick?.();
}, 1000);

// ---------- shared order-building pieces ----------

function menuCard(item, qty, compact = false) {
  return `
    <button class="menu-item ${item.available ? '' : 'soldout'}" data-act="add" data-id="${item.id}" ${item.available ? '' : 'disabled'}>
      ${qty ? `<span class="in-cart">${qty}</span>` : ''}
      <div class="art">${esc(item.emoji || '🍽️')}</div>
      <div class="body">
        <div class="name">${esc(item.name)}</div>
        ${!compact && item.description ? `<div class="muted" style="font-size:13px">${esc(item.description)}</div>` : ''}
        <div class="price">${item.available ? peso(item.price) : 'Sold out'}</div>
      </div>
    </button>`;
}

function cartModel(v) {
  const lines = () => Object.entries(v.cart)
    .map(([id, qty]) => ({ item: S.state.menu.find((i) => i.id === id), qty }))
    .filter((l) => l.item);
  return {
    lines,
    total: () => lines().reduce((s, l) => s + l.item.price * l.qty, 0),
    count: () => lines().reduce((s, l) => s + l.qty, 0),
  };
}

function cartLines(lines) {
  if (!lines.length) return '<div class="empty">Tap an item to add it to your order.</div>';
  return lines.map(({ item, qty }) => `
    <div class="cart-line">
      <div class="grow">
        <div style="font-weight:600">${esc(item.emoji)} ${esc(item.name)}</div>
        <div class="muted num">${peso(item.price)} each${item.available ? '' : ' · <b style="color:var(--danger)">sold out</b>'}</div>
      </div>
      <div class="stepper">
        <button data-act="dec" data-id="${item.id}" aria-label="Remove one">−</button>
        <b class="num" style="min-width:22px;text-align:center">${qty}</b>
        <button data-act="inc" data-id="${item.id}" aria-label="Add one">+</button>
      </div>
    </div>`).join('');
}

function cartActions(v, onStart) {
  return {
    add(d) {
      const item = S.state.menu.find((i) => i.id === d.id);
      if (!item || !item.available) return;
      if (!Object.keys(v.cart).length) onStart?.();
      v.cart[d.id] = (v.cart[d.id] || 0) + 1;
      render();
    },
    inc(d) {
      v.cart[d.id] = (v.cart[d.id] || 0) + 1;
      render();
    },
    dec(d) {
      v.cart[d.id] = (v.cart[d.id] || 0) - 1;
      if (v.cart[d.id] <= 0) delete v.cart[d.id];
      render();
    },
  };
}

// ---------- views ----------

function HomeView() {
  const screens = [
    ['#/kiosk', '🖥️', 'Self-service kiosk', 'Touchscreen ordering for students and teachers. Runs full-screen in the canteen.'],
    ['#/order', '📱', 'Order on phone', 'Same ordering flow for the Android app, with ready notifications.'],
    ['#/track', '🔎', 'Track an order', 'Look up an order number and see its live status.'],
    ['#/pos', '💵', 'Cashier POS', 'Collect cash for kiosk orders, ring up walk-in orders, print receipts, hand over food.'],
    ['#/kitchen', '👩‍🍳', 'Preparation display', 'Incoming orders for the canteen staff. Tap to start and mark ready.'],
    ['#/display', '📺', 'Public order display', 'Big-screen board showing Preparing and Ready for Pickup numbers.'],
    ['#/admin', '⚙️', 'Admin & research', 'Menu, orders, settings, and queue / timing data collection for the study.'],
  ];
  return {
    render: () => `
      <div class="page stack">
        <div class="hero">
          <h1>${esc(S.state.settings.canteenName)} canteen system</h1>
          <p>Order at the kiosk → pay at the cashier → kitchen prepares → your number appears on the display → claim your food.</p>
        </div>
        <div class="launch-grid">
          ${screens.map(([href, ico, title, desc]) => `
            <a class="card launch" href="${href}">
              <div class="ico">${ico}</div><h3>${title}</h3><p>${desc}</p>
            </a>`).join('')}
        </div>
        <p class="muted" style="font-size:13px">Tip: open each screen on its own device. Kiosk and display screens hide the menu bar; triple-tap the top-left corner to leave them.</p>
      </div>`,
  };
}

function OrderView(mode) {
  const kiosk = mode === 'kiosk';
  const v = { data: { search: '', strand: '' }, cat: 'All', cart: {}, startedAt: null, step: 'menu', placed: null, cartOpen: false, placing: false };
  const c = cartModel(v);
  const RESET_MS = 20000;

  function reset() {
    Object.assign(v, { cart: {}, startedAt: null, step: 'menu', placed: null, cartOpen: false, cat: 'All' });
    v.data.search = '';
    v.data.strand = '';
    clearTimeout(v.doneTimer);
    render();
  }

  function menuScreen() {
    const cats = ['All', ...new Set(S.state.menu.map((i) => i.category))];
    const q = v.data.search.trim().toLowerCase();
    const items = S.state.menu.filter((i) => (v.cat === 'All' || i.category === v.cat) && (!q || i.name.toLowerCase().includes(q)));
    const count = c.count();
    return `
      <div class="page"><div class="order-layout">
        <section>
          <div class="hero">
            <h1>Skip the queue. Order ahead.</h1>
            <p>${kiosk
              ? 'Tap your food, confirm your order, then pay at the cashier using your order number.'
              : 'Order from your phone, pay at the cashier, and get notified when your food is ready.'}</p>
          </div>
          <input id="search" class="input" placeholder="Search for food, drinks…" data-bind="search" value="${esc(v.data.search)}" autocomplete="off">
          <div class="chips" style="margin-top:12px">
            ${cats.map((cat) => `<button class="chip ${cat === v.cat ? 'active' : ''}" data-act="cat" data-c="${esc(cat)}">${esc(cat)}</button>`).join('')}
          </div>
          <div class="menu-grid">${items.map((i) => menuCard(i, v.cart[i.id])).join('') || '<div class="empty">No items found.</div>'}</div>
        </section>
        <aside class="card pad cart ${v.cartOpen ? 'open' : ''}">
          <div class="row between"><h2>Your order</h2>${v.cartOpen ? '<button class="btn sm" data-act="closeCart">Close</button>' : ''}</div>
          <div class="cart-lines" id="cart-lines">${cartLines(c.lines())}</div>
          <div class="total-row num"><span>Total</span><span>${peso(c.total())}</span></div>
          <button class="btn primary lg block" data-act="review" ${count ? '' : 'disabled'}>Review order</button>
          ${count ? '<button class="btn block" data-act="reset" style="margin-top:8px">Start over</button>' : ''}
        </aside>
      </div></div>
      ${count && !v.cartOpen ? `<button class="btn primary lg cart-fab" data-act="openCart"><span>View order · ${count} item${count > 1 ? 's' : ''}</span><span class="num">${peso(c.total())}</span></button>` : ''}`;
  }

  function reviewScreen() {
    return `
      <div class="page" style="max-width:640px"><div class="card pad stack">
        <h2>Review your order</h2>
        <table class="tbl">
          ${c.lines().map(({ item, qty }) => `<tr><td>${qty} × ${esc(item.emoji)} ${esc(item.name)}</td><td class="r num">${peso(item.price * qty)}</td></tr>`).join('')}
        </table>
        <div class="total-row num"><span>Total</span><span>${peso(c.total())}</span></div>
        <label class="field">
          <span>Your strand or group (optional, used only for the canteen study — no names are collected)</span>
          <select id="strand" class="input" data-bind="strand">
            <option value="">Prefer not to say</option>
            ${S.state.strands.map((s) => `<option ${v.data.strand === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </label>
        <p class="muted">💵 Payment is cash at the cashier. You'll get an order number after confirming.</p>
        <div class="row">
          <button class="btn lg" data-act="back">← Edit</button>
          <button class="btn primary lg grow" data-act="place" ${v.placing ? 'disabled' : ''}>${v.placing ? 'Sending…' : 'Confirm order'}</button>
        </div>
      </div></div>`;
  }

  function doneScreen() {
    const o = v.placed;
    return `
      <div class="page"><div class="card confirm">
        <div class="muted" style="font-size:18px">Your order number</div>
        <div class="big-number num">${o.code}</div>
        <h2>Please pay ${peso(o.total)} at the cashier</h2>
        <p class="muted">Tell the cashier your number. When your food is ready, your number moves to <b>Ready for Pickup</b> on the display screen.</p>
        <table class="tbl" style="margin:16px 0">${o.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td class="r num">${peso(i.qty * i.price)}</td></tr>`).join('')}</table>
        <div class="row">
          <button class="btn lg" data-act="print">🖨️ Print ticket</button>
          <button class="btn primary lg grow" data-act="reset">Done — new order</button>
        </div>
        <p class="muted" style="margin-top:14px">This screen resets in <span data-countdown="${v.doneAt + RESET_MS}">20</span>s</p>
      </div></div>`;
  }

  return {
    data: v.data,
    render() {
      const body = v.step === 'done' ? doneScreen() : v.step === 'review' ? reviewScreen() : menuScreen();
      return `<div class="${kiosk ? 'kiosk-mode' : ''}">${kiosk ? '<div class="hidden-exit" data-act="exit"></div>' : ''}${body}</div>`;
    },
    onBind(key) {
      if (key === 'search') render();
    },
    tick() {
      // Abandoned kiosk orders reset after 90 s of no touches.
      if (kiosk && v.step !== 'done' && c.count() && Date.now() - S.lastInteract > 90000) reset();
    },
    destroy() {
      clearTimeout(v.doneTimer);
    },
    actions: {
      ...cartActions(v, () => (v.startedAt = now())),
      dec(d) {
        v.cart[d.id] = (v.cart[d.id] || 0) - 1;
        if (v.cart[d.id] <= 0) delete v.cart[d.id];
        if (!Object.keys(v.cart).length) {
          v.startedAt = null;
          v.cartOpen = false;
        }
        render();
      },
      cat(d) { v.cat = d.c; render(); },
      openCart() { v.cartOpen = true; render(); },
      closeCart() { v.cartOpen = false; render(); },
      review() {
        const soldOut = c.lines().filter((l) => !l.item.available);
        if (soldOut.length) {
          soldOut.forEach((l) => delete v.cart[l.item.id]);
          toast(`Removed sold-out item: ${soldOut.map((l) => l.item.name).join(', ')}`, true);
          if (!c.count()) return render();
        }
        v.step = 'review';
        v.cartOpen = false;
        render();
      },
      back() { v.step = 'menu'; render(); },
      reset,
      print() { printReceipt(v.placed); },
      async place() {
        if (v.placing) return;
        v.placing = true;
        render();
        try {
          const order = await api('/api/orders', {
            method: 'POST',
            body: { source: mode, items: c.lines().map((l) => ({ id: l.item.id, qty: l.qty })), strand: v.data.strand, startedAt: v.startedAt },
          });
          if (kiosk) {
            Object.assign(v, { placed: order, step: 'done', doneAt: Date.now() });
            v.doneTimer = setTimeout(reset, RESET_MS);
          } else {
            const mine = JSON.parse(localStorage.getItem('myOrders') || '[]');
            localStorage.setItem('myOrders', JSON.stringify([order.id, ...mine].slice(0, 20)));
            reset();
            location.hash = `#/track/${order.id}`;
          }
        } catch (e) {
          toast(e.message, true);
        } finally {
          v.placing = false;
          render();
        }
      },
    },
  };
}

function TrackView([id]) {
  const v = { data: { code: '' } };
  const mine = () => JSON.parse(localStorage.getItem('myOrders') || '[]');
  const notified = new Set(JSON.parse(localStorage.getItem('notified') || '[]'));

  function checkReady() {
    for (const oid of mine()) {
      const o = findOrder(oid);
      if (o && o.status === 'ready' && !notified.has(oid)) {
        notified.add(oid);
        localStorage.setItem('notified', JSON.stringify([...notified].slice(-50)));
        const msg = `Order ${o.code} is ready for pickup!`;
        toast(msg);
        beep(880, 0.2, 3);
        navigator.vibrate?.([200, 100, 200]);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('MichEats', { body: msg, icon: 'icon.svg' });
      }
    }
  }

  function detail(o) {
    if (!o) return `<div class="card pad empty">Order not found. Order numbers reset every day.<br><br><a href="#/track">Track another order</a></div>`;
    const idx = ['received', 'preparing', 'ready', 'completed'].indexOf(o.status);
    const ahead = todayOrders().filter((x) => ['received', 'preparing'].includes(x.status) && x.createdAt < o.createdAt).length;
    const steps = ['Order received', 'Preparing', 'Ready for pickup', 'Claimed'];
    return `
      <div class="card pad stack" style="text-align:center">
        <div class="muted">Order number</div>
        <div class="big-number num" style="margin:0">${o.code}</div>
        <div>${statusBadge(o)} ${payBadge(o)}</div>
        ${o.status === 'cancelled' ? '<p>This order was cancelled. Please ask the cashier.</p>' : `
          <div class="steps">${steps.map((s, i) => `<div class="step ${i <= idx ? 'done' : ''}"><span class="dot">${i < idx ? '✓' : i + 1}</span>${s}</div>`).join('')}</div>
          ${o.status === 'ready' ? '<h2 style="color:var(--ok)">Your food is ready — claim it at the counter!</h2>' : ''}
          ${['received', 'preparing'].includes(o.status) ? `<p class="muted">${ahead ? `${ahead} order${ahead > 1 ? 's' : ''} ahead of you` : "You're next in line"}</p>` : ''}
          ${!o.paid ? `<p><b>Please pay ${peso(o.total)} at the cashier.</b></p>` : ''}`}
      </div>
      <div class="card pad">
        <h3 style="margin-bottom:8px">Order details</h3>
        <table class="tbl">${o.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td class="r num">${peso(i.qty * i.price)}</td></tr>`).join('')}
          <tr><th>Total</th><th class="r num">${peso(o.total)}</th></tr></table>
      </div>`;
  }

  return {
    data: v.data,
    onState: checkReady,
    render() {
      const my = mine().map(findOrder).filter(Boolean);
      const canNotify = 'Notification' in window && Notification.permission === 'default';
      return `
        <div class="page stack" style="max-width:560px">
          ${id ? detail(findOrder(id)) : `
            <form class="card pad stack" data-submit="lookup">
              <h2>Track your order</h2>
              <div class="row"><input id="code" class="input" inputmode="numeric" placeholder="Order number, e.g. 012" data-bind="code" value="${esc(v.data.code)}" autocomplete="off"><button class="btn primary">Track</button></div>
            </form>`}
          ${canNotify && my.length ? '<button class="btn block" data-act="notify">🔔 Notify me when my order is ready</button>' : ''}
          ${my.length ? `<div class="card pad"><h3 style="margin-bottom:8px">My orders today</h3>
            ${my.map((o) => `<a href="#/track/${o.id}" class="row between" style="padding:8px 0;color:inherit;text-decoration:none;border-bottom:1px solid var(--border)">
              <b class="num" style="font-size:20px">${o.code}</b><span>${statusBadge(o)}</span></a>`).join('')}</div>` : ''}
          ${id ? '<a class="btn block" href="#/track">Track another order</a>' : ''}
          <a class="btn primary block" href="#/order">Place a new order</a>
        </div>`;
    },
    actions: {
      lookup() {
        const q = v.data.code.trim();
        const o = todayOrders().find((x) => x.code === q || x.number === Number(q));
        if (!o) return toast('No order with that number today', true);
        location.hash = `#/track/${o.id}`;
      },
      async notify() {
        await Notification.requestPermission();
        S.sound = true;
        render();
      },
    },
  };
}

function PosView() {
  const v = { staff: true, mode: 'collect', filter: 'unpaid', sel: null, data: { q: '', tendered: '', wtendered: '' }, cart: {}, lastSale: null, busy: false };
  const c = cartModel(v);
  const cashButtons = [20, 50, 100, 200, 500, 1000];

  const matches = (o, q) => !q || o.code.includes(q) || o.number === Number(q);
  function listFor(filter) {
    const all = todayOrders();
    if (filter === 'unpaid') return all.filter((o) => !o.paid && o.status !== 'cancelled');
    if (filter === 'ready') return all.filter((o) => o.status === 'ready');
    return [...all].reverse();
  }
  const changeText = (tendered, total) => {
    const t = Number(tendered);
    if (!tendered) return '—';
    return t >= total ? peso(t - total) : `<span style="color:var(--danger)">Short ${peso(total - t)}</span>`;
  };
  const cashPad = (field, total) => `
    <div class="cash-grid">
      <button type="button" class="btn" data-act="cash" data-f="${field}" data-v="${total}">Exact</button>
      ${cashButtons.map((b) => `<button type="button" class="btn" data-act="cash" data-f="${field}" data-v="${b}" ${b < total ? 'disabled' : ''}>₱${b}</button>`).join('')}
    </div>`;

  function orderDetail(o) {
    if (!o) {
      return `<div class="card pad empty">Select an order on the left, or type the student's order number and press Enter.</div>`;
    }
    const t = Number(v.data.tendered);
    return `
      <div class="card pad stack">
        <div class="row between wrap">
          <div><div class="muted">Order</div><div class="num" style="font-size:44px;font-weight:800;line-height:1">${o.code}</div></div>
          <div style="text-align:right">${statusBadge(o)} ${payBadge(o)}<div class="muted" style="font-size:13px;margin-top:4px">${SOURCE_LABEL[o.source]} · ${timeOf(o.createdAt)}${o.strand ? ' · ' + esc(o.strand) : ''}</div></div>
        </div>
        <table class="tbl">${o.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td class="r num">${peso(i.qty * i.price)}</td></tr>`).join('')}</table>
        <div class="total-row num"><span>Total</span><span>${peso(o.total)}</span></div>
        ${o.status === 'cancelled' ? '<p class="muted">This order was cancelled.</p>' : o.paid ? `
          <div class="row between card pad" style="background:var(--ok-soft);border-color:transparent">
            <div>Cash ${peso(o.tendered)}<br><span class="muted">Paid ${timeOf(o.paidAt)}</span></div>
            <div style="text-align:right"><div class="muted">Change</div><div class="change num">${peso(o.change)}</div></div>
          </div>
          <div class="row wrap">
            <button class="btn" data-act="print" data-id="${o.id}">🖨️ Receipt</button>
            ${o.status === 'ready' ? `<button class="btn ok grow" data-act="claim" data-id="${o.id}">✓ Hand over food (claimed)</button>`
              : o.status === 'completed' ? '<span class="muted">Food already claimed.</span>'
              : `<span class="muted">Kitchen status: ${STATUS_LABEL[o.status]}</span>`}
          </div>` : `
          <form class="stack" data-submit="pay">
            <label class="field"><span>Cash received</span>
              <input id="tendered" class="input num" style="font-size:24px" inputmode="decimal" placeholder="0.00" data-bind="tendered" value="${esc(v.data.tendered)}" autocomplete="off">
            </label>
            ${cashPad('tendered', o.total)}
            <div class="row between"><span class="muted">Change</span><span class="change num">${changeText(v.data.tendered, o.total)}</span></div>
            <button class="btn ok lg block" ${t >= o.total && !v.busy ? '' : 'disabled'}>Receive cash · mark paid</button>
            <div class="row"><button type="button" class="btn sm" data-act="print" data-id="${o.id}">🖨️ Print slip</button>
            <button type="button" class="btn sm danger" data-act="cancel" data-id="${o.id}">Cancel order</button></div>
          </form>`}
      </div>`;
  }

  function collectScreen() {
    const q = v.data.q.trim();
    const list = listFor(v.filter).filter((o) => matches(o, q));
    const counts = { unpaid: listFor('unpaid').length, ready: listFor('ready').length, all: todayOrders().length };
    return `
      <div class="pos-layout">
        <div class="stack">
          <form data-submit="pickFirst"><input id="posq" class="input" style="font-size:20px" inputmode="numeric" placeholder="Order no. ↵" data-bind="q" value="${esc(v.data.q)}" autocomplete="off"></form>
          <div class="chips">
            ${[['unpaid', 'Unpaid'], ['ready', 'Ready'], ['all', 'All today']].map(([k, l]) => `<button class="chip ${v.filter === k ? 'active' : ''}" data-act="filter" data-k="${k}">${l} (${counts[k]})</button>`).join('')}
          </div>
          <div class="order-list" id="order-list">
            ${list.map((o) => `
              <button class="order-row ${v.sel === o.id ? 'active' : ''}" data-act="sel" data-id="${o.id}">
                <span class="code num">${o.code}</span>
                <span class="grow"><b class="num">${peso(o.total)}</b><br><span class="muted" style="font-size:12px">${SOURCE_LABEL[o.source]} · ${timeOf(o.createdAt)}</span></span>
                <span style="text-align:right">${payBadge(o)}<br>${statusBadge(o)}</span>
              </button>`).join('') || '<div class="empty">No orders here.</div>'}
          </div>
        </div>
        <div>${orderDetail(findOrder(v.sel))}</div>
      </div>`;
  }

  function walkinScreen() {
    const total = c.total();
    const t = Number(v.data.wtendered);
    const sale = v.lastSale && findOrder(v.lastSale);
    return `
      <div class="pos-walkin">
        <div class="menu-grid" style="margin:0">${S.state.menu.map((i) => menuCard(i, v.cart[i.id], true)).join('')}</div>
        <aside class="card pad stack" style="align-self:start">
          ${sale ? `
            <div style="text-align:center" class="stack">
              <div class="muted">Order</div><div class="big-number num" style="margin:0">${sale.code}</div>
              <div class="muted">Change</div><div class="change num">${peso(sale.change)}</div>
              <button class="btn block" data-act="print" data-id="${sale.id}">🖨️ Print receipt</button>
              <button class="btn primary lg block" data-act="newSale">New sale</button>
            </div>` : `
            <h2>Walk-in sale</h2>
            <div class="cart-lines" id="walkin-lines" style="max-height:34vh">${cartLines(c.lines())}</div>
            <div class="total-row num"><span>Total</span><span>${peso(total)}</span></div>
            <form class="stack" data-submit="charge">
              <input id="wtendered" class="input num" style="font-size:22px" inputmode="decimal" placeholder="Cash received" data-bind="wtendered" value="${esc(v.data.wtendered)}" autocomplete="off">
              ${cashPad('wtendered', total)}
              <div class="row between"><span class="muted">Change</span><span class="change num">${total ? changeText(v.data.wtendered, total) : '—'}</span></div>
              <button class="btn ok lg block" ${total && t >= total && !v.busy ? '' : 'disabled'}>Charge ${peso(total)}</button>
              ${total ? '<button type="button" class="btn block" data-act="clearCart">Clear</button>' : ''}
            </form>`}
        </aside>
      </div>`;
  }

  function pickupScreen() {
    const ready = listFor('ready');
    return `
      <div class="launch-grid">
        ${ready.map((o) => `
          <div class="card pad stack">
            <div class="row between"><span class="num" style="font-size:40px;font-weight:800">${o.code}</span>${payBadge(o)}</div>
            <div class="muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
            ${o.paid ? `<button class="btn ok block" data-act="claim" data-id="${o.id}">✓ Claimed</button>`
              : `<button class="btn warn block" data-act="collect" data-id="${o.id}">Collect ${peso(o.total)} first</button>`}
          </div>`).join('') || '<div class="card pad empty" style="grid-column:1/-1">No orders waiting for pickup.</div>'}
      </div>`;
  }

  async function run(fn) {
    if (v.busy) return;
    v.busy = true;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { v.busy = false; render(); }
  }

  return {
    staff: true,
    data: v.data,
    onBind(key) {
      if (key === 'q' || key === 'tendered' || key === 'wtendered') render();
    },
    render() {
      const unpaid = listFor('unpaid').length;
      const ready = listFor('ready').length;
      const sales = todayOrders().filter((o) => o.paid).reduce((s, o) => s + o.total, 0);
      return `
        <div class="page">
          <div class="row between wrap" style="margin-bottom:8px">
            <h1 style="font-size:22px">Cashier POS</h1>
            <span class="muted num">Today's cash sales: <b>${peso(sales)}</b></span>
          </div>
          <div class="tabs">
            <button class="${v.mode === 'collect' ? 'active' : ''}" data-act="mode" data-m="collect">💵 Collect payment (${unpaid})</button>
            <button class="${v.mode === 'walkin' ? 'active' : ''}" data-act="mode" data-m="walkin">🧾 Walk-in sale</button>
            <button class="${v.mode === 'pickup' ? 'active' : ''}" data-act="mode" data-m="pickup">🛎️ Pickup (${ready})</button>
          </div>
          ${v.mode === 'collect' ? collectScreen() : v.mode === 'walkin' ? walkinScreen() : pickupScreen()}
        </div>`;
    },
    actions: {
      ...cartActions(v, () => (v.lastSale = null)),
      mode(d) { v.mode = d.m; render(); },
      filter(d) { v.filter = d.k; render(); },
      sel(d) {
        v.sel = d.id;
        v.data.tendered = '';
        render();
        document.getElementById('tendered')?.focus();
      },
      collect(d) {
        Object.assign(v, { mode: 'collect', filter: 'unpaid', sel: d.id });
        v.data.tendered = '';
        render();
      },
      pickFirst() {
        const q = v.data.q.trim();
        const o = listFor('all').find((x) => matches(x, q) && !x.paid && x.status !== 'cancelled') || listFor('all').find((x) => matches(x, q));
        if (!o) return toast('No order with that number', true);
        v.sel = o.id;
        v.data.tendered = '';
        v.data.q = '';
        render();
        document.getElementById('tendered')?.focus();
      },
      cash(d) {
        v.data[d.f] = d.v;
        render();
      },
      pay() {
        const o = findOrder(v.sel);
        if (!o) return;
        run(async () => {
          await api(`/api/orders/${o.id}/pay`, { method: 'POST', body: { tendered: Number(v.data.tendered) } });
          v.data.tendered = '';
          toast(`Order ${o.code} paid`);
        });
      },
      cancel(d) {
        const o = findOrder(d.id);
        if (!o || !confirm(`Cancel order ${o.code}?`)) return;
        run(() => api(`/api/orders/${o.id}/status`, { method: 'POST', body: { status: 'cancelled' } }));
      },
      claim(d) {
        run(async () => {
          const o = await api(`/api/orders/${d.id}/status`, { method: 'POST', body: { status: 'completed' } });
          toast(`Order ${o.code} claimed`);
        });
      },
      print(d) { printReceipt(findOrder(d.id)); },
      clearCart() { v.cart = {}; v.data.wtendered = ''; render(); },
      newSale() { v.lastSale = null; v.cart = {}; v.data.wtendered = ''; render(); },
      charge() {
        const total = c.total();
        if (!total || Number(v.data.wtendered) < total) return;
        run(async () => {
          const o = await api('/api/orders', {
            method: 'POST',
            body: { source: 'pos', items: c.lines().map((l) => ({ id: l.item.id, qty: l.qty })), tendered: Number(v.data.wtendered) },
          });
          v.lastSale = o.id;
          v.cart = {};
          v.data.wtendered = '';
        });
      },
    },
  };
}

function KitchenView() {
  const seen = new Set(todayOrders().map((o) => o.id));
  const cols = [
    ['received', 'New orders', 'Start preparing', 'preparing', 'warn'],
    ['preparing', 'Preparing', 'Mark ready', 'ready', 'ok'],
    ['ready', 'Ready — waiting for pickup', null, null, null],
  ];
  return {
    staff: true,
    onState() {
      const fresh = todayOrders().filter((o) => !seen.has(o.id));
      fresh.forEach((o) => seen.add(o.id));
      if (fresh.some((o) => o.status === 'received')) beep(660, 0.12, 2);
    },
    render() {
      return `
        <div class="page">
          <div class="row between wrap" style="margin-bottom:14px">
            <h1 style="font-size:22px">Preparation display</h1>
            ${soundBtn()}
          </div>
          <div class="kds">
            ${cols.map(([status, title, label, next, cls]) => {
              const list = todayOrders().filter((o) => o.status === status).sort((a, b) => a.createdAt - b.createdAt);
              return `
                <section class="kds-col">
                  <h2>${title} <span class="badge ${STATUS_BADGE[status]}">${list.length}</span></h2>
                  ${list.map((o) => `
                    <article class="card ticket ${status}">
                      <div class="row between">
                        <span class="code num">${o.code}</span>
                        <span style="text-align:right">${payBadge(o)}<br><span class="muted num age" data-since="${status === 'ready' ? o.readyAt : o.createdAt}" data-late="${status === 'ready' ? '' : 10}">${mmss(now() - (status === 'ready' ? o.readyAt : o.createdAt))}</span></span>
                      </div>
                      <ul>${o.items.map((i) => `<li><b>${i.qty}×</b> ${esc(i.name)}</li>`).join('')}</ul>
                      <div class="muted" style="font-size:12px;margin-bottom:8px">${SOURCE_LABEL[o.source]} · placed ${timeOf(o.createdAt)}</div>
                      ${label ? `<div class="row">
                        ${status === 'preparing' ? `<button class="btn sm" data-act="set" data-id="${o.id}" data-s="received" title="Move back">↩</button>` : ''}
                        <button class="btn ${cls} block" data-act="set" data-id="${o.id}" data-s="${next}">${label}</button></div>`
                        : `<div class="row">
                          <button class="btn sm" data-act="set" data-id="${o.id}" data-s="preparing" title="Move back">↩</button>
                          ${o.paid ? `<button class="btn block" data-act="set" data-id="${o.id}" data-s="completed">Claimed</button>` : '<span class="muted grow" style="text-align:center">Awaiting payment</span>'}</div>`}
                    </article>`).join('') || '<div class="card pad empty">Nothing here.</div>'}
                </section>`;
            }).join('')}
          </div>
        </div>`;
    },
    actions: {
      async set(d) {
        try {
          await api(`/api/orders/${d.id}/status`, { method: 'POST', body: { status: d.s } });
        } catch (e) {
          toast(e.message, true);
        }
      },
    },
  };
}

function DisplayView() {
  const flashUntil = {};
  const ready = new Set(todayOrders().filter((o) => o.status === 'ready').map((o) => o.id));
  return {
    onState() {
      for (const o of todayOrders()) {
        if (o.status === 'ready' && !ready.has(o.id)) {
          ready.add(o.id);
          flashUntil[o.id] = Date.now() + 4000;
          beep(880, 0.18, 3);
          say(`Order ${o.number} is ready for pickup`);
        }
      }
    },
    render() {
      const preparing = todayOrders().filter((o) => o.status === 'received' || o.status === 'preparing').sort((a, b) => a.createdAt - b.createdAt);
      const readyList = todayOrders().filter((o) => o.status === 'ready').sort((a, b) => b.readyAt - a.readyAt);
      return `
        <div class="display-page">
          <div class="hidden-exit" data-act="exit"></div>
          <div class="display-head">
            <div><h1>🍴 ${esc(S.state.settings.canteenName)}</h1><div style="color:#93a0b5">Order status board</div></div>
            <div class="row" style="gap:16px">${soundBtn()}<div class="clock num" data-clock></div></div>
          </div>
          <div class="display-cols">
            <section class="display-col preparing">
              <h2><span>⏳ Preparing</span><span>${preparing.length}</span></h2>
              <div class="num-grid">${preparing.map((o) => `<div class="num-tile num">${o.code}</div>`).join('') || '<div style="color:#64748b">No orders in progress</div>'}</div>
            </section>
            <section class="display-col ready">
              <h2><span>✅ Ready for pickup</span><span>${readyList.length}</span></h2>
              <div class="num-grid">${readyList.map((o) => `<div class="num-tile num ${flashUntil[o.id] > Date.now() ? 'flash' : ''}">${o.code}</div>`).join('') || '<div style="color:#64748b">No orders ready yet</div>'}</div>
            </section>
          </div>
          <div class="display-foot">Pay at the cashier, then claim your food when your number shows under Ready for pickup.</div>
        </div>`;
    },
  };
}

function AdminView() {
  const blankItem = { mf_id: '', mf_name: '', mf_category: 'Meals', mf_price: '', mf_emoji: '🍽️', mf_desc: '' };
  const v = {
    tab: 'research',
    research: null,
    queue: 0,
    data: { ...blankItem, q_note: '', t_note: '', s_name: '', s_pin: '' },
    timers: JSON.parse(localStorage.getItem('timers') || '[]'),
  };
  let refresh;
  const saveTimers = () => localStorage.setItem('timers', JSON.stringify(v.timers));

  async function loadResearch() {
    try {
      v.research = await api('/api/research');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---- research tab ----
  const stat = (s) => (s && s.n ? `<span class="num">${fmt(s.mean)}</span> <span class="muted num">± ${fmt(s.sd)} · n=${s.n}</span>` : '<span class="muted">no data</span>');
  function compRow(label, unit, c) {
    const b = c.baseline.mean, t = c.trial.mean;
    const pct = b ? ((t - b) / b) * 100 : null;
    const test = c.test;
    return `<tr>
      <td><b>${label}</b><br><span class="muted" style="font-size:12px">${unit}</span></td>
      <td>${stat(c.baseline)}</td>
      <td>${stat(c.trial)}</td>
      <td class="r num">${pct == null || t == null ? '—' : `${pct > 0 ? '+' : ''}${fmt(pct, 1)}%`}</td>
      <td class="r num">${test ? fmt(test.t, 2) : '—'}</td>
      <td class="r num">${test ? (test.p < 0.001 ? '< .001' : fmt(test.p, 3)) : '—'}</td>
      <td>${test ? `<span class="sig ${test.significant ? 'yes' : ''}">${test.significant ? 'Yes' : 'No'}</span>` : '<span class="muted">need ≥ 2 each</span>'}</td>
    </tr>`;
  }

  function researchTab() {
    const r = v.research;
    const phase = S.state.settings.phase;
    const pinQ = encodeURIComponent(S.pin);
    if (!r) return '<div class="empty">Loading research data…</div>';
    return `
      <div class="stack">
        <div class="card pad row between wrap">
          <div>
            <h2 style="font-size:18px">Data collection phase</h2>
            <p class="muted" style="margin:4px 0 0">New queue counts and stopwatch times are tagged with this phase. Record the old manual process as <b>Before</b>, then switch to <b>During kiosk trial</b>.</p>
          </div>
          <div class="phase-toggle">
            <button class="${phase === 'baseline' ? 'active' : ''}" data-act="phase" data-p="baseline">Before (manual)</button>
            <button class="${phase === 'trial' ? 'active' : ''}" data-act="phase" data-p="trial">During kiosk trial</button>
          </div>
        </div>

        <div class="grid-2">
          <div class="card pad stack">
            <h3>Queue length counter</h3>
            <p class="muted" style="margin:0">Count the students standing in line right now, then tap <b>Log count</b>. Repeat at regular intervals (e.g. every 2 minutes) during recess and lunch.</p>
            <div class="counter">
              <button class="btn" data-act="q" data-d="-1">−</button>
              <div class="value num">${v.queue}</div>
              <button class="btn" data-act="q" data-d="1">+</button>
            </div>
            <input id="q_note" class="input" placeholder="Note (optional), e.g. lunch break, Day 2" data-bind="q_note" value="${esc(v.data.q_note)}">
            <button class="btn primary block" data-act="logQueue">Log count (${phase === 'baseline' ? 'Before' : 'Trial'})</button>
            ${logList(r.queueLogs.slice(0, 6), 'queue-logs', (l) => `<b class="num">${l.count}</b> in line`)}
          </div>

          <div class="card pad stack">
            <h3>Stopwatch</h3>
            <p class="muted" style="margin:0"><b>Transaction time</b>: from when a student starts ordering until the order is confirmed.<br><b>Waiting time</b>: from when a student joins the line until they receive their food. Several timers can run at once.</p>
            <div class="row">
              <button class="btn primary grow" data-act="startTimer" data-t="transaction">+ Transaction timer</button>
              <button class="btn primary grow" data-act="startTimer" data-t="waiting">+ Waiting timer</button>
            </div>
            <div class="timers">
              ${v.timers.map((t, i) => `
                <div class="timer">
                  <span class="badge ${t.type === 'waiting' ? 'warn' : 'blue'}">${t.type === 'waiting' ? 'Waiting' : 'Transaction'} #${i + 1}</span>
                  <span class="t num" data-since="${t.start}">${mmss(now() - t.start)}</span>
                  <button class="btn ok sm" data-act="stopTimer" data-id="${t.id}">Stop & save</button>
                  <button class="btn sm" data-act="dropTimer" data-id="${t.id}" title="Discard">✕</button>
                </div>`).join('') || '<div class="muted" style="font-size:14px">No timers running.</div>'}
            </div>
            <input id="t_note" class="input" placeholder="Note added to the next saved time (optional)" data-bind="t_note" value="${esc(v.data.t_note)}">
            ${logList(r.timings.slice(0, 6), 'timings', (t) => `${t.type === 'waiting' ? 'Waiting' : 'Transaction'} <b class="num">${fmt(t.ms / 60000)}</b> min`)}
          </div>
        </div>

        <div class="card pad">
          <h3>Before vs during the kiosk trial</h3>
          <p class="muted">Based on your own observations (queue counts and stopwatch times), so both phases are measured the same way. Mean ± SD (times in minutes); Welch's t-test, α = 0.05.</p>
          <div class="scroll-x"><table class="tbl">
            <thead><tr><th>Measure</th><th>Before (manual)</th><th>During trial</th><th class="r">Change</th><th class="r">t</th><th class="r">p</th><th>Significant?</th></tr></thead>
            <tbody>
              ${compRow('2.1 Average queue length', 'students in line', r.comparison.queueLength)}
              ${compRow('2.2 Average transaction processing time', 'minutes', r.comparison.transaction)}
              ${compRow('2.3 Average waiting time', 'minutes', r.comparison.waiting)}
            </tbody>
          </table></div>
        </div>

        <div class="card pad stack">
          <h3>Measured automatically by the system</h3>
          <p class="muted" style="margin:0">The kiosk and app timestamp every step. This is supporting data for the trial days (there is no system data for the old manual process).</p>
          <div class="kpis">
            ${kpi('Avg. kiosk transaction time', r.system.transaction, 'min', 'first item tapped → order confirmed')}
            ${kpi('Avg. wait until ready', r.system.waitReady, 'min', 'order placed → marked ready')}
            ${kpi('Avg. wait until claimed', r.system.waitClaim, 'min', 'order placed → food handed over')}
            ${kpi('Avg. open orders at placement', r.system.openOrders, '', 'orders still being served when a new one arrives')}
          </div>
          <div class="scroll-x"><table class="tbl">
            <thead><tr><th>Date</th><th class="r">Orders</th><th>Kiosk / App / Cashier</th><th>Groups</th><th class="r">Transaction (min)</th><th class="r">Wait→ready</th><th class="r">Wait→claim</th><th class="r">Observed queue</th><th class="r">Sales</th></tr></thead>
            <tbody>${r.byDay.map((d) => `<tr>
              <td class="num">${d.date}</td><td class="r num">${d.orders}</td>
              <td class="num">${d.bySource.kiosk} / ${d.bySource.app} / ${d.bySource.pos}</td>
              <td style="font-size:12px">${Object.entries(d.strands).map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</td>
              <td class="r num">${fmt(d.transaction.mean)}</td><td class="r num">${fmt(d.waitReady.mean)}</td><td class="r num">${fmt(d.waitClaim.mean)}</td>
              <td class="r num">${fmt(d.observedQueue.mean, 1)}</td><td class="r num">${peso(d.sales)}</td>
            </tr>`).join('') || '<tr><td colspan="9" class="empty">No orders yet.</td></tr>'}</tbody>
          </table></div>
        </div>

        <div class="card pad row wrap">
          <b class="grow">Export for Excel / SPSS</b>
          <a class="btn" href="/api/export.csv?type=orders&pin=${pinQ}">⬇ Orders CSV</a>
          <a class="btn" href="/api/export.csv?type=queue&pin=${pinQ}">⬇ Queue counts CSV</a>
          <a class="btn" href="/api/export.csv?type=timings&pin=${pinQ}">⬇ Stopwatch CSV</a>
        </div>
      </div>`;
  }
  const kpi = (label, s, unit, sub) => `
    <div class="card kpi"><div class="label">${label}</div>
      <div class="value num">${s.n ? fmt(s.mean) : '—'} <span style="font-size:14px" class="muted">${unit}</span></div>
      <div class="sub">${sub}${s.n ? ` · n=${s.n}` : ''}</div></div>`;
  const logList = (items, kind, line) => (items.length ? `
    <div style="font-size:14px">${items.map((x) => `
      <div class="row between" style="padding:6px 0;border-top:1px solid var(--border)">
        <span>${line(x)} <span class="muted">· ${x.phase === 'baseline' ? 'Before' : 'Trial'} · ${timeOf(x.at)} ${x.date}${x.note ? ' · ' + esc(x.note) : ''}</span></span>
        <button class="btn sm danger" data-act="delLog" data-k="${kind}" data-id="${x.id}" title="Delete">✕</button>
      </div>`).join('')}</div>` : '');

  // ---- menu tab ----
  function menuTab() {
    const d = v.data;
    return `
      <div class="stack">
        <form class="card pad stack" data-submit="saveItem">
          <h3>${d.mf_id ? 'Edit item' : 'Add menu item'}</h3>
          <div class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
            <label class="field"><span>Name</span><input id="mf_name" class="input" data-bind="mf_name" value="${esc(d.mf_name)}" required></label>
            <label class="field"><span>Category</span><input id="mf_category" class="input" list="cats" data-bind="mf_category" value="${esc(d.mf_category)}"></label>
            <label class="field"><span>Price (₱)</span><input id="mf_price" class="input" inputmode="decimal" data-bind="mf_price" value="${esc(d.mf_price)}" required></label>
            <label class="field"><span>Icon (emoji)</span><input id="mf_emoji" class="input" data-bind="mf_emoji" value="${esc(d.mf_emoji)}"></label>
          </div>
          <label class="field"><span>Description (optional)</span><input id="mf_desc" class="input" data-bind="mf_desc" value="${esc(d.mf_desc)}"></label>
          <datalist id="cats">${[...new Set(S.state.menu.map((i) => i.category))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <div class="row"><button class="btn primary">${d.mf_id ? 'Save changes' : 'Add item'}</button>${d.mf_id ? '<button type="button" class="btn" data-act="cancelEdit">Cancel</button>' : ''}</div>
        </form>
        <div class="card scroll-x"><table class="tbl">
          <thead><tr><th></th><th>Item</th><th>Category</th><th class="r">Price</th><th>Available</th><th></th></tr></thead>
          <tbody>${S.state.menu.map((i) => `<tr>
            <td style="font-size:24px">${esc(i.emoji)}</td><td><b>${esc(i.name)}</b>${i.description ? `<br><span class="muted">${esc(i.description)}</span>` : ''}</td>
            <td>${esc(i.category)}</td><td class="r num">${peso(i.price)}</td>
            <td><button class="btn sm ${i.available ? '' : 'danger'}" data-act="toggleItem" data-id="${i.id}">${i.available ? '✓ Available' : '✕ Sold out'}</button></td>
            <td class="r" style="white-space:nowrap"><button class="btn sm" data-act="editItem" data-id="${i.id}">Edit</button> <button class="btn sm danger" data-act="delItem" data-id="${i.id}">Delete</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  }

  // ---- orders tab ----
  function ordersTab() {
    const list = [...todayOrders()].reverse();
    const span = (a, b) => (a && b ? fmt((b - a) / 60000) : '—');
    return `
      <div class="card scroll-x"><table class="tbl">
        <thead><tr><th>No.</th><th>Placed</th><th>Source</th><th>Group</th><th>Items</th><th class="r">Total</th><th>Status</th><th class="r">Txn min</th><th class="r">Wait→ready</th><th></th></tr></thead>
        <tbody>${list.map((o) => `<tr>
          <td class="num"><b>${o.code}</b></td><td class="num">${timeOf(o.createdAt)}</td><td>${SOURCE_LABEL[o.source]}</td><td>${esc(o.strand) || '—'}</td>
          <td style="font-size:13px">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</td>
          <td class="r num">${peso(o.total)}</td><td>${statusBadge(o)} ${payBadge(o)}</td>
          <td class="r num">${span(o.startedAt, o.createdAt)}</td><td class="r num">${span(o.createdAt, o.readyAt)}</td>
          <td>${['completed', 'cancelled'].includes(o.status) ? '' : `<button class="btn sm danger" data-act="cancelOrder" data-id="${o.id}">Cancel</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="10" class="empty">No orders today.</td></tr>'}</tbody>
      </table></div>`;
  }

  // ---- settings tab ----
  function settingsTab() {
    const base = location.origin + location.pathname;
    const links = [['Kiosk', 'kiosk'], ['Phone ordering (Android app)', 'order'], ['Cashier POS', 'pos'], ['Preparation display', 'kitchen'], ['Public display', 'display']];
    return `
      <div class="grid-2">
        <form class="card pad stack" data-submit="saveSettings">
          <h3>Settings</h3>
          <label class="field"><span>Canteen / system name</span><input id="s_name" class="input" data-bind="s_name" value="${esc(v.data.s_name || S.state.settings.canteenName)}"></label>
          <label class="field"><span>New staff PIN (4–8 digits, leave blank to keep)</span><input id="s_pin" class="input" inputmode="numeric" data-bind="s_pin" value="${esc(v.data.s_pin)}" autocomplete="off"></label>
          <button class="btn primary">Save settings</button>
          <button type="button" class="btn" data-act="logout">Lock this device (log out)</button>
        </form>
        <div class="card pad stack">
          <h3>Open on each device</h3>
          <p class="muted" style="margin:0">Open these links on each device. If you run the server on a laptop instead of Vercel, devices must be on the same Wi-Fi and use the laptop's network address shown in the terminal, not <code>localhost</code>.</p>
          ${links.map(([l, r]) => `<div><div class="muted" style="font-size:13px">${l}</div><code style="word-break:break-all">${esc(base)}#/${r}</code></div>`).join('')}
        </div>
      </div>`;
  }

  return {
    staff: true,
    data: v.data,
    enter() {
      if (v.tab === 'research') loadResearch();
    },
    destroy() { clearInterval(refresh); },
    render() {
      const tabs = [['research', '📊 Research'], ['menu', '🍽️ Menu'], ['orders', '🧾 Orders today'], ['settings', '⚙️ Settings']];
      const body = { research: researchTab, menu: menuTab, orders: ordersTab, settings: settingsTab }[v.tab]();
      return `
        <div class="page">
          <h1 style="font-size:22px;margin-bottom:8px">Admin</h1>
          <div class="tabs">${tabs.map(([k, l]) => `<button class="${v.tab === k ? 'active' : ''}" data-act="tab" data-k="${k}">${l}</button>`).join('')}</div>
          ${body}
        </div>`;
    },
    init() {
      refresh = setInterval(() => v.tab === 'research' && S.pin && loadResearch(), 15000);
      if (S.pin) loadResearch();
    },
    actions: {
      tab(d) {
        v.tab = d.k;
        render();
        if (d.k === 'research') loadResearch();
      },
      async phase(d) {
        try {
          await api('/api/settings', { method: 'POST', body: { phase: d.p } });
          toast(d.p === 'baseline' ? 'Now recording: Before (manual process)' : 'Now recording: During kiosk trial');
        } catch (e) { toast(e.message, true); }
      },
      q(d) { v.queue = Math.max(0, v.queue + Number(d.d)); render(); },
      async logQueue() {
        try {
          await api('/api/queue-logs', { method: 'POST', body: { count: v.queue, note: v.data.q_note } });
          toast(`Logged queue length: ${v.queue}`);
          loadResearch();
        } catch (e) { toast(e.message, true); }
      },
      startTimer(d) {
        v.timers.push({ id: Math.random().toString(36).slice(2), type: d.t, start: now() });
        saveTimers();
        render();
      },
      dropTimer(d) {
        v.timers = v.timers.filter((t) => t.id !== d.id);
        saveTimers();
        render();
      },
      async stopTimer(d) {
        const t = v.timers.find((x) => x.id === d.id);
        if (!t) return;
        const ms = now() - t.start;
        try {
          await api('/api/timings', { method: 'POST', body: { type: t.type, ms, note: v.data.t_note } });
          v.timers = v.timers.filter((x) => x.id !== d.id);
          saveTimers();
          toast(`Saved ${t.type} time: ${mmss(ms)}`);
          loadResearch();
        } catch (e) { toast(e.message, true); }
      },
      async delLog(d) {
        if (!confirm('Delete this observation?')) return;
        try {
          await api(`/api/${d.k}/${d.id}`, { method: 'DELETE' });
          loadResearch();
        } catch (e) { toast(e.message, true); }
      },
      async saveItem() {
        const d = v.data;
        try {
          await api('/api/menu', {
            method: 'POST',
            body: {
              id: d.mf_id || undefined, name: d.mf_name, category: d.mf_category, price: Number(d.mf_price),
              emoji: d.mf_emoji, description: d.mf_desc,
              available: d.mf_id ? S.state.menu.find((i) => i.id === d.mf_id)?.available !== false : true,
            },
          });
          toast(d.mf_id ? 'Item updated' : 'Item added');
          Object.assign(v.data, blankItem);
          render();
        } catch (e) { toast(e.message, true); }
      },
      editItem(d) {
        const i = S.state.menu.find((x) => x.id === d.id);
        Object.assign(v.data, { mf_id: i.id, mf_name: i.name, mf_category: i.category, mf_price: String(i.price), mf_emoji: i.emoji, mf_desc: i.description || '' });
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      cancelEdit() { Object.assign(v.data, blankItem); render(); },
      async toggleItem(d) {
        const i = S.state.menu.find((x) => x.id === d.id);
        try { await api('/api/menu', { method: 'POST', body: { ...i, available: !i.available } }); } catch (e) { toast(e.message, true); }
      },
      async delItem(d) {
        const i = S.state.menu.find((x) => x.id === d.id);
        if (!confirm(`Delete ${i.name} from the menu?`)) return;
        try { await api(`/api/menu/${d.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message, true); }
      },
      async cancelOrder(d) {
        const o = findOrder(d.id);
        if (!confirm(`Cancel order ${o.code}?`)) return;
        try { await api(`/api/orders/${d.id}/status`, { method: 'POST', body: { status: 'cancelled' } }); } catch (e) { toast(e.message, true); }
      },
      async saveSettings() {
        const body = { canteenName: v.data.s_name || S.state.settings.canteenName };
        if (v.data.s_pin) {
          if (!/^\d{4,8}$/.test(v.data.s_pin)) return toast('PIN must be 4–8 digits', true);
          body.staffPin = v.data.s_pin;
        }
        try {
          await api('/api/settings', { method: 'POST', body });
          if (body.staffPin) {
            S.pin = body.staffPin;
            sessionStorage.setItem('pin', S.pin);
            v.data.s_pin = '';
          }
          toast('Settings saved');
          render();
        } catch (e) { toast(e.message, true); }
      },
      logout() {
        S.pin = '';
        sessionStorage.removeItem('pin');
        location.hash = '#/';
      },
    },
  };
}

// ---------- router & chrome ----------

const ROUTES = {
  '': () => HomeView(),
  kiosk: () => OrderView('kiosk'),
  order: () => OrderView('app'),
  track: (args) => TrackView(args),
  pos: () => PosView(),
  kitchen: () => KitchenView(),
  display: () => DisplayView(),
  admin: () => AdminView(),
};
const STAFF_NAV = [['pos', 'Cashier POS'], ['kitchen', 'Kitchen'], ['display', 'Display'], ['kiosk', 'Kiosk'], ['admin', 'Admin']];
const PUBLIC_NAV = [['order', 'Order'], ['track', 'Track order']];

function setChrome() {
  const bar = document.getElementById('topbar');
  const fullscreen = S.route === 'kiosk' || S.route === 'display';
  bar.hidden = fullscreen;
  const nav = ['order', 'track'].includes(S.route) ? PUBLIC_NAV : S.route ? STAFF_NAV : [];
  document.getElementById('nav').innerHTML = nav.map(([r, l]) => `<a href="#/${r}" class="${r === S.route ? 'active' : ''}">${l}</a>`).join('');
  if (S.state) document.getElementById('brand-name').textContent = S.state.settings.canteenName;
}

function route() {
  const [name = '', ...args] = location.hash.replace(/^#\/?/, '').split('/');
  S.view?.destroy?.();
  S.route = ROUTES[name] ? name : '';
  S.view = ROUTES[S.route](args);
  setChrome();
  window.scrollTo(0, 0);
  render();
  S.view.init?.();
}

// Live updates by polling: the server answers "unchanged" cheaply unless something changed.
let pollTimer = null;
let polling = false;
let pollAgain = false;
async function poll() {
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  pollAgain = false;
  clearTimeout(pollTimer);
  try {
    const res = await fetch(`/api/state${S.state ? `?v=${S.state.version}` : ''}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    S.offset = data.serverTime - Date.now();
    if (!S.online && S.state) toast('Reconnected');
    S.online = true;
    S.error = '';
    if (!data.unchanged) {
      S.state = data;
      setChrome();
      S.view?.onState?.();
      render();
    }
  } catch (e) {
    if (S.online) toast('Connection lost — reconnecting…', true);
    S.online = false;
    S.error = e.message;
    if (!S.state) render();
  } finally {
    polling = false;
    pollTimer = setTimeout(poll, pollAgain ? 0 : document.hidden ? 15000 : 2000);
  }
}
document.addEventListener('visibilitychange', () => !document.hidden && poll());

// theme
const themeBtn = document.getElementById('theme-btn');
const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

window.addEventListener('hashchange', route);
route();
poll();
