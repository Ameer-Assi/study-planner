import {
  COURSES, TRACKED, DAY_NAMES, DEFAULT_PLAN, DEFAULT_SETTINGS, nowLocal, addDays, weekOf, fmtShortDate, guessCourse,
  migratePlan, ensureWeek, pruneGoals, weekGoals, repeatOf, sortedParts, goalDone, partDone, dayParts, lateParts,
  unplacedGoals, planningLeft, usualDays,
} from './shared.js';

const VERSION = '2.2.0';
// Preview mode: runs without a server and keeps everything on this device.
const DEMO = !!globalThis.PLANNER_DEMO;
const PRE = DEMO ? 'spd-' : 'sp-';

// ---------- Storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const store = {
  key: DEMO ? 'preview' : LS.get('sp-key', null),
  state: LS.get(PRE + 'state', null),
  outbox: DEMO ? [] : LS.get('sp-outbox', []),
};
const ui = {
  view: 'today', which: null, sheet: null, confirm: null,
  addTitle: '', addCourse: 'auto', addRepeat: false,
  schedDay: null, classForm: null, scrollTarget: null,
  sync: DEMO ? 'demo' : 'idle', push: null, msgs: {}, pendingRender: false, lastDate: null,
};
const save = () => { LS.set(PRE + 'state', store.state); if (!DEMO) LS.set('sp-outbox', store.outbox); };

// ---------- Helpers ----------
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cname = (k) => COURSES[k]?.name || 'General';
const sw = (k) => (COURSES[k] ? `<span class="sw" style="--c:var(--${esc(k)})"></span>` : '<span class="sw dash"></span>');
const uid = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clock = () => { const L = nowLocal(); return { today: L.date, dow: L.dow, week: weekOf(L.date), hm: L.hm }; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (d) => DAY_NAMES[d].slice(0, 3);
const andList = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const ICON_WARN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>';
const ICON_FLAG = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>';
const ICON_REPEAT = '<svg class="ico rep" viewBox="0 0 24 24" role="img" aria-label="Repeats every week"><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19M16 3l3 3-3 3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5M8 21l-3-3 3-3"/></svg>';
const GRIP = '<span class="grip" aria-hidden="true"><svg viewBox="0 0 12 20"><circle cx="3" cy="4" r="1.5"/><circle cx="9" cy="4" r="1.5"/><circle cx="3" cy="10" r="1.5"/><circle cx="9" cy="10" r="1.5"/><circle cx="3" cy="16" r="1.5"/><circle cx="9" cy="16" r="1.5"/></svg></span>';

function b64u(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let toastTimer;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text;
  document.body.appendChild(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2600);
}

// The week the Plan screen shows. On Saturday it opens on next week, since that's planning day.
const planWhich = () => ui.which || (clock().dow === 6 ? 'next' : 'this');
const planWeek = () => (planWhich() === 'next' ? addDays(clock().week, 7) : clock().week);
const weekRange = (w) => `${fmtShortDate(w)} – ${fmtShortDate(addDays(w, 6))}`;

// ---------- Server ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${store.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Server error ${res.status}`); e.status = res.status; throw e; }
  return data;
}

function fromServer(d) {
  const ticks = {};
  for (const t of d.ticks) (ticks[t.week] ||= {})[t.item] = { done: t.done, updated: t.updated };
  return { plan: d.plan, planUpdated: d.planUpdated, settings: d.settings, settingsUpdated: d.settingsUpdated, ticks, vapidPublic: d.vapidPublic };
}

// Brings a state up to date: converts an old plan, and fills in this week's and
// next week's repeating goals. Nothing is sent to the server for this.
function prepare(s) {
  s.plan = migratePlan(s.plan).plan;
  s.ticks ||= {};
  const { week } = clock();
  ensureWeek(s.plan, week); ensureWeek(s.plan, addDays(week, 7));
  return s;
}

function applyOp(s, op) {
  if (op.type === 'tick') (s.ticks[op.week] ||= {})[op.item] = { done: op.done, updated: op.updated };
  else if (op.type === 'plan') { s.plan = op.plan; s.planUpdated = op.updated; }
  else if (op.type === 'settings') { s.settings = op.settings; s.settingsUpdated = op.updated; }
}

function setSync(state) { ui.sync = DEMO ? 'demo' : state; const el = document.querySelector('.sync'); if (el) el.outerHTML = syncHTML(); }

let flushing = false;
async function flush() {
  if (DEMO) { store.outbox = []; return; }
  if (flushing || !store.key || !store.outbox.length) return;
  if (!navigator.onLine) { setSync('offline'); return; }
  flushing = true;
  try {
    while (store.outbox.length) {
      const batch = store.outbox.slice(0, 200);
      await api('/api/sync', { method: 'POST', body: { ops: batch } });
      store.outbox.splice(0, batch.length);
      save();
    }
    setSync('ok');
  } catch (e) {
    setSync(e.status === 401 ? 'auth' : navigator.onLine ? 'error' : 'offline');
  } finally { flushing = false; }
}

async function pull() {
  if (!store.key) return;
  if (DEMO) {
    store.state = prepare(store.state || { plan: structuredClone(DEFAULT_PLAN), settings: structuredClone(DEFAULT_SETTINGS), ticks: {}, vapidPublic: null });
    save(); render(); return;
  }
  if (!navigator.onLine) { setSync('offline'); render(); return; }
  if (!store.state) setSync('loading');
  try {
    await flush();
    const d = await api('/api/state?weeks=8');
    const s = fromServer(d);
    for (const op of store.outbox) applyOp(s, op);
    store.state = prepare(s); save();
    setSync(store.outbox.length ? 'pending' : 'ok');
  } catch (e) {
    setSync(e.status === 401 ? 'auth' : navigator.onLine ? 'error' : 'offline');
    ui.msgs.sync = e.message;
  }
  render();
}

function commit(...ops) {
  const now = Date.now();
  for (const op of ops) {
    op.updated = now;
    applyOp(store.state, op);
    if (!DEMO) store.outbox.push(op);
  }
  save();
  if (ui.sync === 'ok') ui.sync = 'pending';
  render();
  flush();
}

function commitPlan(mutator) {
  const plan = structuredClone(store.state.plan);
  mutator(plan);
  const { week } = clock();
  ensureWeek(plan, week); ensureWeek(plan, addDays(week, 7));
  pruneGoals(plan, week);
  commit({ type: 'plan', plan });
}
function commitSettings(mutator) {
  const settings = structuredClone(store.state.settings);
  mutator(settings);
  commit({ type: 'settings', settings });
}
const tickOp = (week, item, done) => ({ type: 'tick', week, item, done, effort: null });
const findGoal = (plan, id) => plan.goals.find((g) => g.id === id);
const findPart = (plan, id) => { for (const g of plan.goals) { const p = g.parts.find((x) => x.id === id); if (p) return { g, p }; } return null; };

// ---------- Goal actions ----------
// A day's order is the order of its parts' `at` values. Reordering numbers them 1, 2, 3…,
// so anything placed later (at = now) still lands at the end.
const dayOrder = (week, d) => dayParts(store.state.plan, week, d).map((x) => x.part.id);
function withInserted(week, d, id, before) {
  const ids = dayOrder(week, d).filter((x) => x !== id);
  const at = before ? ids.indexOf(before) : -1;
  ids.splice(at >= 0 ? at : ids.length, 0, id);
  return ids;
}
function orderDay(plan, ids) { ids.forEach((id, i) => { const f = findPart(plan, id); if (f) f.p.at = i + 1; }); }

// `before`: the part to go in front of, null for the end of the day, undefined when no position was picked.
function placeGoal(goalId, d, quiet, before) {
  const g = findGoal(store.state.plan, goalId);
  if (!g) return;
  if (g.parts.some((p) => p.day === d)) { toast(`Already on ${DAY_NAMES[d]}`); return; }
  const id = uid();
  const order = before === undefined ? null : withInserted(g.week, d, id, before);
  commitPlan((p) => { findGoal(p, goalId).parts.push({ id, day: d, note: '', at: Date.now() }); if (order) orderDay(p, order); });
  const days = sortedParts(findGoal(store.state.plan, goalId)).map((p) => short(p.day));
  if (!quiet) toast(days.length > 1 ? `${g.title}: split over ${andList(days)}` : `${g.title}: ${DAY_NAMES[d]}`);
}
function movePart(partId, d, before) {
  const f = findPart(store.state.plan, partId);
  if (!f) return;
  const same = f.p.day === d;
  // The goal is already on that day: the two parts become one.
  if (!same && f.g.parts.some((p) => p.day === d)) {
    commitPlan((p) => {
      const { g, p: x } = findPart(p, partId);
      const there = g.parts.find((q) => q.day === d);
      if (x.note && !there.note) there.note = x.note;
      g.parts = g.parts.filter((q) => q.id !== partId);
    });
    toast(`Joined with its ${DAY_NAMES[d]} part`);
    return;
  }
  let order = null;
  if (same || before !== undefined) {
    order = withInserted(f.g.week, d, partId, before ?? null);
    if (same && order.join() === dayOrder(f.g.week, d).join()) return; // dropped where it was
  }
  commitPlan((p) => { const x = findPart(p, partId).p; x.day = d; x.at = Date.now(); if (order) orderDay(p, order); });
  if (!same) toast(`Moved to ${DAY_NAMES[d]}`);
}
function removePart(partId, quiet) {
  const f = findPart(store.state.plan, partId);
  if (!f) return;
  commitPlan((p) => { const g = findPart(p, partId).g; g.parts = g.parts.filter((x) => x.id !== partId); });
  if (!quiet) toast(`Taken off ${DAY_NAMES[f.p.day]}`);
}

function addGoal() {
  const input = document.getElementById('g-title');
  const title = (input?.value || '').trim();
  if (!title) { input?.focus(); return; }
  const week = planWeek();
  const course = ui.addCourse === 'auto' ? guessCourse(title) : ui.addCourse;
  const repeat = ui.addRepeat;
  ui.addTitle = ''; ui.addRepeat = false;
  input.value = ''; input.blur();
  commitPlan((p) => {
    if (repeat) p.repeats.push({ id: uid(), title, course, since: week, usual: [] });
    else p.goals.push({ id: uid(), title, course, week, parts: [] });
  });
  toast(repeat ? 'Added. It comes back every week.' : 'Goal added');
  document.getElementById('g-title')?.focus({ preventScroll: true });
}

// ---------- Rendering ----------
function syncHTML() {
  const map = {
    ok: 'Synced', pending: `Saving ${store.outbox.length}`, offline: 'Offline', error: 'Sync failed',
    auth: 'Key rejected', loading: 'Loading', idle: '', demo: 'Preview',
  };
  const cls = ui.sync === 'ok' ? '' : ui.sync === 'pending' || ui.sync === 'loading' || ui.sync === 'demo' ? 'pending' : ui.sync === 'offline' ? 'offline' : 'error';
  return `<span class="sync ${cls}" role="status"><i></i>${map[ui.sync] ?? ''}</span>`;
}

function headerHTML(title, sub) {
  return `<header class="top"><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>${syncHTML()}</header>`;
}

// Seven small day marks for a goal: outlined where it's placed, filled once that day is ticked.
function dotsHTML(g, wt) {
  const on = new Map(g.parts.map((p) => [p.day, p]));
  const days = sortedParts(g).map((p) => DAY_NAMES[p.day]);
  return `<span class="dots" style="--c:var(--${COURSES[g.course] ? esc(g.course) : 'fg'})" role="img" aria-label="${days.length ? `On ${esc(andList(days))}` : 'Not on any day'}">${DAY_NAMES.map((n, d) => {
    const p = on.get(d);
    return `<i class="${p ? (partDone(wt, g, p) ? 'done' : 'on') : ''}">${n[0]}</i>`;
  }).join('')}</span>`;
}

// One goal on one day: a tick box, the goal, and that day's note.
function partHTML(x, week, opts = {}) {
  const { goal: g, part: p } = x;
  const wt = store.state.ticks[week] || {};
  const done = partDone(wt, g, p);
  const tags = `${x.of > 1 ? `<span class="tag">part ${x.n} of ${x.of}</span>` : ''}${opts.late && !done ? `<span class="tag late">${opts.from != null ? esc(short(opts.from)) : 'late'}</span>` : ''}`;
  return `<li class="part${done ? ' done' : ''}"${opts.drag ? ` data-drag="part" data-id="${esc(p.id)}"` : ''}>
    ${opts.drag ? GRIP : ''}
    <input type="checkbox" class="check" id="chk-${esc(p.id)}" data-act="tick" data-week="${esc(week)}" data-item="${esc(p.id)}" data-goal="${esc(g.id)}"${done ? ' checked' : ''} aria-label="${esc(g.title)}${p.note ? ', ' + esc(p.note) : ''}">
    <button type="button" class="part-body" data-act="open-goal" data-id="${esc(g.id)}" data-part="${esc(p.id)}">
      <span class="t">${sw(g.course)}<span>${esc(g.title)}</span></span>
      ${p.note ? `<span class="note">${esc(p.note)}</span>` : ''}
      ${tags ? `<span class="meta">${tags}</span>` : ''}
    </button>
    ${opts.move && !done ? `<button type="button" class="btn small-btn" data-act="part-today" data-id="${esc(p.id)}">To today</button>` : ''}
  </li>`;
}

function goalHTML(g, week, opts = {}) {
  const s = store.state;
  const wt = s.ticks[week] || {};
  const done = goalDone(wt, g);
  const loose = !g.parts.length && !done;
  return `<li class="goal${done ? ' done' : ''}${loose ? ' loose' : ''}"${opts.drag ? ` data-drag="goal" data-id="${esc(g.id)}"` : ''}>
    ${opts.drag ? GRIP : ''}
    <button type="button" class="goal-body" data-act="open-goal" data-id="${esc(g.id)}">
      <span class="t">${sw(g.course)}<span>${esc(g.title)}</span>${repeatOf(s.plan, g) ? ICON_REPEAT : ''}</span>
      <span class="goal-sub">${dotsHTML(g, wt)}${done ? '<span class="tag ok">done</span>' : loose ? '<span class="tag warn">no day yet</span>' : ''}</span>
    </button>
  </li>`;
}

// Goals from last week that weren't finished: move what's left into this week, or drop it.
function leftoversHTML() {
  const s = store.state;
  const { week } = clock();
  const prev = addDays(week, -7);
  const left = weekGoals(s.plan, prev).filter((g) => !goalDone(s.ticks[prev], g));
  if (!left.length) return '';
  return `<section class="card alert"><div class="card-head"><h2>${ICON_FLAG}Left from last week</h2><span class="small muted">${plural(left.length, 'goal')}</span></div>
    <ul class="list">${left.map((g) => {
      const n = g.parts.filter((p) => partDone(s.ticks[prev], g, p)).length;
      return `<li><div class="grow"><div class="t">${sw(g.course)}<span>${esc(g.title)}</span></div>
        <div class="small muted">${g.parts.length ? `${n} of ${plural(g.parts.length, 'day')} done` : 'was never placed on a day'}</div></div>
        <div class="row tight"><button type="button" class="btn small-btn" data-act="goal-carry" data-id="${esc(g.id)}">Move to this week</button>
        <button type="button" class="btn ghost" data-act="goal-drop" data-id="${esc(g.id)}">Drop</button></div></li>`;
    }).join('')}</ul></section>`;
}

function viewToday() {
  const s = store.state;
  const { today, dow, week } = clock();
  const wt = s.ticks[week] || {};
  const goals = weekGoals(s.plan, week);
  let h = headerHTML(DAY_NAMES[dow], fmtShortDate(today));
  if (ui.sync === 'auth') h += `<section class="card alert bad"><h2>${ICON_WARN}App key rejected</h2><p class="small">The server didn’t accept this device’s key. Check APP_KEY in Cloudflare, or sign out in Settings and enter it again.</p></section>`;

  if (dow === 6) {
    const next = addDays(week, 7);
    const left = planningLeft(s.plan, s.ticks[next], next);
    if (left.unplaced || !left.goals) {
      h += `<section class="card callout"><h2>Plan next week</h2>
        <p class="small">${left.goals ? `${plural(left.unplaced, 'goal')} for ${esc(weekRange(next))} ${left.unplaced === 1 ? 'isn’t' : 'aren’t'} on a day yet.` : `No goals for ${esc(weekRange(next))} yet.`}</p>
        <div class="row"><button type="button" class="btn primary" data-act="plan-open" data-which="next">Plan next week</button></div></section>`;
    }
  }

  h += leftoversHTML();

  const late = lateParts(s.plan, wt, week, dow);
  if (late.length) {
    h += `<section class="card alert"><div class="card-head"><h2>${ICON_WARN}Behind</h2><span class="small muted">${late.length} from earlier days</span></div>
      <ul class="parts">${late.map((x) => partHTML(x, week, { late: true, from: x.part.day, move: true })).join('')}</ul></section>`;
  }

  const loose = unplacedGoals(s.plan, wt, week);
  if (loose.length) {
    h += `<section class="card alert"><div class="card-head"><h2>${ICON_WARN}Not on any day</h2><span class="small muted">${plural(loose.length, 'goal')}</span></div>
      <p class="small">${esc(andList(loose.map((g) => g.title)))}</p>
      <div class="row"><button type="button" class="btn" data-act="plan-open" data-which="this">Put ${loose.length === 1 ? 'it' : 'them'} on a day</button></div></section>`;
  }

  const parts = dayParts(s.plan, week, dow);
  const done = parts.filter((x) => partDone(wt, x.goal, x.part)).length;
  const d = s.plan.days[dow];
  h += `<section class="card" data-drop="day" data-day="${dow}"><div class="card-head"><h2>Today</h2><span class="mono small muted">${parts.length ? `${done}/${parts.length}` : esc(d.hours)}</span></div>
    ${parts.length ? `<ul class="parts">${parts.map((x) => partHTML(x, week, { drag: parts.length > 1 })).join('')}</ul>`
      : `<p class="small muted">${goals.length ? 'Nothing is placed on today.' : 'No goals for this week yet.'}</p>
         <div class="row"><button type="button" class="btn" data-act="plan-open" data-which="this">${goals.length ? 'Open the plan' : 'Plan this week'}</button></div>`}
    ${d.classes.length ? `<div class="row between"><p class="label">Classes</p><button type="button" class="btn ghost" data-act="edit-classes">Edit</button></div><ul class="classes">${d.classes.map((c) => `<li><span class="ct">${esc(c.time)}</span>${sw(c.course)}<span>${esc(c.label)}</span></li>`).join('')}</ul>` : ''}
  </section>`;

  if (goals.length) {
    const fin = goals.filter((g) => goalDone(wt, g)).length;
    h += `<section class="card"><div class="card-head"><h2>This week’s goals</h2><span class="mono small muted">${fin}/${goals.length}</span></div>
      <ul class="goals">${goals.map((g) => goalHTML(g, week)).join('')}</ul></section>`;
  }
  return h;
}

function viewPlan() {
  const s = store.state;
  const { today, dow, week } = clock();
  const which = planWhich();
  const w = planWeek();
  const wt = s.ticks[w] || {};
  const goals = weekGoals(s.plan, w);
  const usual = goals.filter((g) => !g.parts.length && !goalDone(wt, g) && usualDays(s.plan, g).length);
  const loose = unplacedGoals(s.plan, wt, w).length;

  let h = headerHTML('Plan', weekRange(w));
  h += `<div class="switch" role="tablist" aria-label="Week">
    <button type="button" role="tab" aria-selected="${which === 'this'}" data-act="which" data-which="this">This week</button>
    <button type="button" role="tab" aria-selected="${which === 'next'}" data-act="which" data-which="next">Next week</button></div>`;
  if (which === 'this') h += leftoversHTML();

  h += `<section class="card tray" data-drop="tray">
    <div class="card-head"><h2>Goals</h2><span class="small ${loose ? 'warn-text' : 'muted'}">${goals.length ? (loose ? `${loose} without a day` : 'all on a day') : ''}</span></div>
    ${goals.length ? `<ul class="goals">${goals.map((g) => goalHTML(g, w, { drag: true })).join('')}</ul>
      <p class="small muted">Hold a goal and drag it to a day. Drag it again to split it over more days. Inside a day, drag items up or down to set their order.</p>`
      : '<p class="small muted">Write what you want done this week, like “Probability HW”. Then put each goal on one or more days.</p>'}
    ${usual.length ? `<div class="row"><button type="button" class="btn" data-act="usual">Put ${usual.length === 1 ? 'the repeating goal' : `${usual.length} repeating goals`} on ${usual.length === 1 ? 'its' : 'their'} usual days</button></div>` : ''}
    <div class="addgoal">
      <input type="text" id="g-title" data-act="add-title" value="${esc(ui.addTitle)}" placeholder="Add a goal" enterkeyhint="done" autocomplete="off" aria-label="New goal">
      <div class="row">
        <select id="g-course" data-act="add-course" aria-label="Course">
          <option value="auto"${ui.addCourse === 'auto' ? ' selected' : ''}>Course: auto</option>
          <option value=""${ui.addCourse === '' ? ' selected' : ''}>General</option>
          ${TRACKED.map((k) => `<option value="${k}"${k === ui.addCourse ? ' selected' : ''}>${esc(COURSES[k].name)}</option>`).join('')}
        </select>
        <label class="toggle"><input type="checkbox" id="g-rec" data-act="add-repeat"${ui.addRepeat ? ' checked' : ''}> Every week</label>
        <button type="button" class="btn primary" data-act="goal-add">Add</button>
      </div>
    </div>
  </section>`;

  h += s.plan.days.map((d, i) => {
    const date = addDays(w, i);
    const parts = dayParts(s.plan, w, i);
    const isToday = date === today;
    const past = which === 'this' && i < dow;
    return `<section class="card day${isToday ? ' today' : ''}" data-drop="day" data-day="${i}" aria-label="${DAY_NAMES[i]}">
      <div class="card-head"><h2>${DAY_NAMES[i]} <span class="mono small muted">${esc(fmtShortDate(date))}</span>${isToday ? ' <span class="tag now">today</span>' : ''}</h2><span class="small muted">${esc(d.hours)}</span></div>
      ${parts.length ? `<ul class="parts">${parts.map((x) => partHTML(x, w, { drag: true, late: past })).join('')}</ul>` : '<p class="empty">Nothing here yet</p>'}
    </section>`;
  }).join('');

  // Shown only while dragging: a strip of days pinned to the bottom, so any day is one move away.
  h += `<div class="dock" aria-hidden="true">
    <div class="dock-off" data-drop="tray">Take it off this day</div>
    <div class="dock-days">${s.plan.days.map((d, i) => {
      const n = dayParts(s.plan, w, i).length;
      return `<div class="dock-day${addDays(w, i) === today ? ' today' : ''}" data-drop="day" data-day="${i}"><b>${short(i)}</b><span>${n || ''}</span></div>`;
    }).join('')}</div></div>`;
  return h;
}

// The goal sheet: rename, pick days (more than one splits the goal), a note per day, repeat, delete.
function sheetHTML() {
  if (!ui.sheet) return '';
  const s = store.state;
  const g = findGoal(s.plan, ui.sheet.goalId);
  if (!g || g.deleted) { ui.sheet = null; return ''; }
  const wt = s.ticks[g.week] || {};
  const parts = sortedParts(g);
  const whole = !!wt[g.id]?.done;
  const done = goalDone(wt, g);
  const rep = repeatOf(s.plan, g);
  const id = esc(g.id);
  let del;
  if (ui.confirm === 'del-goal') {
    del = rep
      ? `<button type="button" class="btn danger" data-act="goal-skip" data-id="${id}">Skip this week only</button><button type="button" class="btn danger" data-act="goal-delete" data-id="${id}">Delete for good</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button>`
      : `<button type="button" class="btn danger" data-act="goal-delete" data-id="${id}">Delete goal</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button>`;
  } else del = `<button type="button" class="btn ghost danger" data-act="confirm" data-key="del-goal">Delete</button>`;
  return `<div class="scrim" data-act="sheet-close"></div>
  <section class="sheet" role="dialog" aria-modal="true" aria-label="Goal">
    <div class="card-head"><p class="label">Goal · ${esc(weekRange(g.week))}</p><button type="button" class="btn primary" data-act="sheet-close">Done</button></div>
    <label class="field"><span>Goal</span><input type="text" id="s-title" data-act="goal-title" data-id="${id}" value="${esc(g.title)}" autocomplete="off"></label>
    <label class="field"><span>Course</span><select id="s-course" data-act="goal-course" data-id="${id}">
      <option value="">General</option>${TRACKED.map((k) => `<option value="${k}"${k === g.course ? ' selected' : ''}>${esc(COURSES[k].name)}</option>`).join('')}</select></label>
    <div class="field"><span>Days${parts.length > 1 ? ` · split over ${parts.length}` : ''}</span>
      <div class="daypick" role="group" aria-label="Days for this goal">${DAY_NAMES.map((n, d) =>
        `<button type="button" class="seg" data-act="goal-day" data-id="${id}" data-day="${d}" aria-pressed="${g.parts.some((p) => p.day === d)}">${n.slice(0, 3)}</button>`).join('')}</div>
      <p class="small muted">${parts.length ? 'Pick more days to split the goal between them.' : 'Pick one day, or several to split the goal between them.'}</p></div>
    ${parts.map((p) => `<label class="field"><span>${DAY_NAMES[p.day]}${partDone(wt, g, p) ? ' · done' : ''}</span>
      <input type="text" id="note-${esc(p.id)}" data-act="part-note" data-id="${esc(p.id)}" value="${esc(p.note)}" placeholder="Note for this day, like “questions 1–3”" autocomplete="off"></label>`).join('')}
    <label class="toggle"><input type="checkbox" id="s-rep" data-act="goal-repeat" data-id="${id}"${rep ? ' checked' : ''}> Repeat every week</label>
    <div class="row between">
      <button type="button" class="btn" data-act="goal-whole" data-id="${id}">${whole ? 'Mark as not done' : done ? 'Done' : 'Mark the whole goal done'}</button>
      <div class="row tight">${del}</div>
    </div>
  </section>`;
}

// ---------- Classes and hours ----------
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const padTime = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t.padStart(5, '0') : '');
const unpadTime = (t) => String(t || '').replace(/^0(\d:)/, '$1');
const defaultLabel = (course) => (COURSES[course] ? `${COURSES[course].name} lecture` : 'Class');

function classFormHTML(f) {
  const isNew = f.id === 'new';
  return `<div class="editbox" data-form="class">
    <div class="row">
      <label class="field" style="max-width:130px"><span>Time</span><input type="time" id="c-time" data-act="cf" data-k="time" value="${esc(padTime(f.time))}"></label>
      <label class="field"><span>Course</span><select id="c-course" data-act="cf" data-k="course">
        ${TRACKED.map((k) => `<option value="${k}"${k === f.course ? ' selected' : ''}>${esc(COURSES[k].name)}</option>`).join('')}
        <option value=""${f.course === '' ? ' selected' : ''}>Other</option></select></label>
    </div>
    <label class="field"><span>Name</span><input type="text" id="c-label" data-act="cf" data-k="label" value="${esc(f.label)}" placeholder="${esc(defaultLabel(f.course))}" autocomplete="off"></label>
    ${f.err ? `<p class="msg err">${esc(f.err)}</p>` : ''}
    <div class="row between">
      <div class="row tight">${isNew ? '' : ui.confirm === 'class-del'
        ? '<button type="button" class="btn danger" data-act="class-delete">Delete class</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button>'
        : '<button type="button" class="btn ghost danger" data-act="confirm" data-key="class-del">Delete</button>'}</div>
      <div class="row tight"><button type="button" class="btn ghost" data-act="class-cancel">Cancel</button><button type="button" class="btn primary" data-act="class-save">${isNew ? 'Add class' : 'Save'}</button></div>
    </div>
  </div>`;
}

function scheduleCardHTML() {
  const s = store.state;
  const d = ui.schedDay ?? clock().dow;
  const day = s.plan.days[d];
  const f = ui.classForm;
  return `<section class="card" id="sched"><h2>Classes and hours</h2>
    <div class="daypick" role="group" aria-label="Day">${DAY_NAMES.map((n, i) =>
      `<button type="button" class="seg" data-act="sched-day" data-day="${i}" aria-pressed="${i === d}">${n.slice(0, 3)}</button>`).join('')}</div>
    <label class="field"><span>${DAY_NAMES[d]} hours</span><input type="text" id="h-hours" data-act="day-hours" data-day="${d}" value="${esc(day.hours)}" placeholder="8:30–20:00" autocomplete="off"></label>
    <p class="label">Classes</p>
    ${day.classes.length ? `<ul class="list">${day.classes.map((c) => f?.id === c.id ? `<li style="display:block">${classFormHTML(f)}</li>` : `<li style="align-items:center">
      <span class="ct mono small muted" style="width:44px;flex:none">${esc(c.time)}</span>${sw(c.course)}<span class="grow">${esc(c.label)}</span>
      <button type="button" class="btn ghost" data-act="class-edit" data-id="${esc(c.id)}">Edit</button></li>`).join('')}</ul>` : '<p class="small muted">No classes on this day.</p>'}
    ${f?.id === 'new' ? classFormHTML(f) : '<div class="row"><button type="button" class="btn" data-act="class-new">Add class</button></div>'}
    <p class="small muted">Classes show on the Today screen. Hours are only a reminder for yourself.</p>
  </section>`;
}

function timeField(id, label, value) {
  return `<label class="field"><span>${label}</span><input type="time" id="${id}" step="900" value="${esc(value)}" data-act="reminder-time" data-key="${id.replace('r-', '')}"></label>`;
}

function viewSettings() {
  const s = store.state;
  const r = s.settings.reminders || DEFAULT_SETTINGS.reminders;
  const push = ui.push;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let pushLine;
  if (DEMO) pushLine = 'This is a preview. Reminders work in the installed app.';
  else if (!s.vapidPublic) pushLine = 'The server has no notification keys yet. Add VAPID_PUBLIC and VAPID_PRIVATE in Cloudflare.';
  else if (!('PushManager' in window)) pushLine = standalone ? 'This browser doesn’t support notifications.' : 'On iPhone, add this app to your Home Screen first, then open it from there to turn on reminders.';
  else if (push === 'on') pushLine = 'Reminders are on for this device.';
  else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') pushLine = 'Notifications are blocked. Allow them in your phone’s settings for this app.';
  else pushLine = 'Reminders are off on this device.';

  const reps = s.plan.repeats || [];
  return headerHTML('Settings', '') + `
    <section class="card"><h2>Reminders</h2>
      <p class="small">${esc(pushLine)}</p>
      <div class="row">
        ${push === 'on'
          ? '<button type="button" class="btn" data-act="push-test">Send a test</button><button type="button" class="btn ghost" data-act="push-off">Turn off on this device</button>'
          : `<button type="button" class="btn primary" data-act="push-on"${DEMO || !s.vapidPublic || !('PushManager' in window) ? ' disabled' : ''}>Turn on reminders</button>`}
      </div>
      ${ui.msgs.push ? `<p class="msg">${esc(ui.msgs.push)}</p>` : ''}
      <div class="row">${timeField('r-morning', 'Morning summary', r.morning)}${timeField('r-evening', 'Evening nudge', r.evening)}</div>
      <div class="row">${timeField('r-weekendMorning', 'Fri–Sat morning', r.weekendMorning)}${timeField('r-weekendEvening', 'Fri–Sat nudge', r.weekendEvening)}</div>
      <label class="toggle"><input type="checkbox" id="r-off" data-act="reminders-off"${r.off ? ' checked' : ''}> Pause all reminders</label>
      <p class="small muted">Israel time, in 15-minute steps. The morning summary lists what’s on today, anything behind, and goals with no day. The evening nudge only comes if something is still open. On Saturday both tell you if next week isn’t planned.</p>
    </section>
    ${scheduleCardHTML()}
    <section class="card"><div class="card-head"><h2>Repeating goals</h2><span class="small muted">${reps.length}</span></div>
      ${reps.length ? `<ul class="list">${reps.map((x) => `<li style="align-items:center"><div class="grow t">${sw(x.course)}<span>${esc(x.title)}</span></div>
        ${ui.confirm === 'rep-' + x.id
          ? `<button type="button" class="btn danger" data-act="repeat-stop" data-id="${esc(x.id)}">Stop repeating</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button>`
          : `<button type="button" class="btn ghost" data-act="confirm" data-key="rep-${esc(x.id)}">Stop</button>`}</li>`).join('')}</ul>` : '<p class="small muted">None. Tick “Every week” when you add a goal on the Plan screen.</p>'}
      <p class="small muted">These show up as goals every week, ready to put on days. Stopping one keeps the goals already in this week and next.</p>
    </section>
    <section class="card"><h2>This device</h2>
      ${DEMO ? `<p class="small">Preview: everything you do here stays in this browser.</p>
        <div class="row">${ui.confirm === 'demo-reset'
          ? '<button type="button" class="btn danger" data-act="demo-reset">Clear the preview</button><button type="button" class="btn ghost" data-act="cancel-confirm">Cancel</button>'
          : '<button type="button" class="btn ghost" data-act="confirm" data-key="demo-reset">Start the preview over</button>'}</div>`
      : `<div class="row"><button type="button" class="btn" data-act="sync-now">Sync now</button>${syncHTML()}</div>
      ${ui.msgs.sync && ui.sync !== 'ok' ? `<p class="msg err">${esc(ui.msgs.sync)}</p>` : ''}
      <div class="row">${ui.confirm === 'signout'
        ? '<button type="button" class="btn danger" data-act="signout">Sign out and clear this device</button><button type="button" class="btn ghost" data-act="cancel-confirm">Cancel</button>'
        : '<button type="button" class="btn ghost" data-act="confirm" data-key="signout">Sign out</button>'}</div>`}
      <p class="small muted">Version ${VERSION}.${DEMO ? '' : ' Your data lives in your Cloudflare database and syncs to every device with the app key.'}</p>
    </section>`;
}

// ---------- Setup ----------
function viewSetup() {
  const pending = LS.get('sp-pending', null);
  const kb = (name, val) => `<div class="keybox"><div class="row"><span class="mono small">${name}</span><button type="button" class="btn ghost" data-act="copy" data-val="${esc(val)}">Copy</button></div><code>${esc(val)}</code></div>`;
  return `<header class="top"><div><h1>Set up your planner</h1><p class="sub">One-time setup. Takes about five minutes.</p></div></header>
    <section class="card"><h2>First time on any device</h2>
      ${pending ? `
        <p class="small">These three secrets connect the app to your server. Keep this screen open until they’re saved in Cloudflare.</p>
        ${kb('APP_KEY', pending.APP_KEY)}${kb('VAPID_PUBLIC', pending.VAPID_PUBLIC)}${kb('VAPID_PRIVATE', pending.VAPID_PRIVATE)}
        <ol class="steps-list">
          <li>Open the Cloudflare dashboard, then Workers &amp; Pages, then <b>study-planner</b>.</li>
          <li>Go to Settings, then Variables and Secrets, and choose Add.</li>
          <li>Add each of the three above as type <b>Secret</b>, with the exact name shown.</li>
          <li>Deploy, wait about a minute, then come back here.</li>
        </ol>
        <p class="small muted">Save APP_KEY in your password manager too. You’ll need it to connect your laptop.</p>
        <div class="row"><button type="button" class="btn primary" data-act="setup-done">I’ve added them</button><button type="button" class="btn ghost" data-act="setup-regen">Make new keys</button></div>`
      : `<p class="small">Generates your app key and notification keys on this device.</p>
        <div class="row"><button type="button" class="btn primary" data-act="setup-gen">Generate keys</button></div>`}
      ${ui.msgs.setup ? `<p class="msg ${ui.msgs.setupOk ? 'ok' : 'err'}">${esc(ui.msgs.setup)}</p>` : ''}
    </section>
    <section class="card"><h2>Already set up</h2>
      <p class="small">Connecting another device? Enter the APP_KEY you saved.</p>
      <label class="field"><span>App key</span><input type="password" id="k-input" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="row end"><button type="button" class="btn" data-act="setup-connect">Connect</button></div>
    </section>`;
}

async function connectWithKey(key, pendingFlow) {
  ui.msgs.setup = 'Checking the server…'; ui.msgs.setupOk = true; render();
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    if (!h.configured) throw new Error('The server doesn’t have APP_KEY yet. Add the secrets, deploy, and try again in a minute.');
    if (pendingFlow && !h.push) throw new Error('APP_KEY is set, but VAPID_PUBLIC or VAPID_PRIVATE is missing.');
    store.key = key;
    await api('/api/state?weeks=1');
  } catch (e) {
    store.key = null;
    ui.msgs.setup = e.status === 401 ? 'That key doesn’t match the APP_KEY on the server.' : e.message;
    ui.msgs.setupOk = false; render(); return;
  }
  LS.set('sp-key', store.key);
  LS.del('sp-pending');
  ui.msgs.setup = null;
  location.hash = '#today';
  await pull();
}

// ---------- Push ----------
async function refreshPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { ui.push = 'unsupported'; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    ui.push = sub ? 'on' : 'off';
  } catch { ui.push = 'off'; }
}

async function pushOn() {
  ui.msgs.push = 'Asking for permission…'; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications weren’t allowed.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(store.state.vapidPublic) });
    await api('/api/subscribe', { method: 'POST', body: { sub: sub.toJSON() } });
    ui.push = 'on'; ui.msgs.push = 'Reminders are on. Try “Send a test”.';
  } catch (e) { ui.msgs.push = e.message; }
  render();
}
async function pushOff() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api('/api/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
    ui.push = 'off'; ui.msgs.push = 'Reminders are off on this device.';
  } catch (e) { ui.msgs.push = e.message; }
  render();
}
async function pushTest() {
  ui.msgs.push = 'Sending…'; render();
  try {
    const r = await api('/api/test-push', { method: 'POST' });
    ui.msgs.push = r.error ? r.error : r.sent ? 'Sent. It should arrive in a few seconds.' : 'The push service didn’t accept it. Turn reminders off and on again.';
  } catch (e) { ui.msgs.push = e.message; }
  render();
}

// ---------- Main render ----------
function render() {
  // Never rebuild the screen under a finger: the tap or drag in progress would lose its target.
  if (drag.active || press.hold || Date.now() - press.at < 4000) { ui.pendingRender = true; return; }
  const a = document.activeElement;
  if (a && $app.contains(a) && (a.matches('input[type=text], input[type=password], textarea, select'))) {
    ui.pendingRender = true; return;
  }
  ui.pendingRender = false;
  let view = ui.view;
  if (!store.key) view = 'setup';
  $nav.hidden = view === 'setup';
  for (const link of $nav.querySelectorAll('a')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (view !== 'setup' && !store.state) {
    $app.innerHTML = headerHTML('Study planner', '') + `<section class="card"><p>${navigator.onLine ? 'Loading your plan…' : 'Connect to the internet once to load your plan. After that it works offline.'}</p>${ui.msgs.sync ? `<p class="msg err">${esc(ui.msgs.sync)}</p>` : ''}</section>`;
    return;
  }
  const views = { today: viewToday, plan: viewPlan, settings: viewSettings, setup: viewSetup };
  const sheetScroll = document.querySelector('.sheet')?.scrollTop || 0;
  $app.innerHTML = (views[view] || viewToday)() + (view === 'setup' ? '' : sheetHTML());
  document.body.classList.toggle('has-sheet', !!ui.sheet && view !== 'setup');
  const sheet = document.querySelector('.sheet');
  if (sheet) sheet.scrollTop = sheetScroll;
}
$app.addEventListener('focusout', () => setTimeout(() => { if (ui.pendingRender) render(); }, 0));

// Keeps the goal sheet above the on-screen keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const lift = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift);
}

// A press in progress. Screen updates wait until it's over (see render).
const press = { at: 0, hold: false };
const pressEnd = () => { press.at = 0; setTimeout(() => { if (ui.pendingRender) render(); }, 0); };
// A field saves when focus leaves it, which on a tap happens just before the click lands.
// Holding the update until the end of that tap keeps the button under the finger alive.
const holdRender = () => { press.hold = true; setTimeout(() => { press.hold = false; if (ui.pendingRender) render(); }, 0); };
document.addEventListener('pointerdown', () => { press.at = Date.now(); }, true);
document.addEventListener('pointerup', pressEnd, true);
document.addEventListener('pointercancel', pressEnd, true);

// ---------- Drag and drop ----------
// Works with a finger, a pen or a mouse. Touch: hold a goal for a moment, or grab its
// grip to start right away. While dragging, a strip of days is pinned to the bottom.
const drag = { pending: null, active: null, timer: 0, clickBlock: 0, raf: 0 };
const HOLD_MS = 280;

function cancelPending() { clearTimeout(drag.timer); drag.pending = null; }

function startDrag(x, y) {
  const p = drag.pending;
  cancelPending();
  if (!p || !p.src.isConnected || !store.state) return;
  const title = p.src.querySelector('.t')?.innerHTML || '';
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost'; ghost.innerHTML = `<span class="t">${title}</span>`;
  document.body.appendChild(ghost);
  drag.active = { id: p.id, src: p.src, type: p.src.dataset.drag, item: p.src.dataset.id, ghost, touch: p.touch, x0: p.x, y0: p.y, x, y, armed: !p.touch || p.onGrip, target: null };
  p.src.classList.add('drag-src');
  document.body.classList.add('dragging', `drag-${drag.active.type}`);
  try { navigator.vibrate?.(8); } catch {}
  moveDrag(x, y);
  drag.raf = requestAnimationFrame(autoScroll);
}

function dropTargetAt(x, y) {
  const a = drag.active;
  const el = document.elementFromPoint(x, y)?.closest('[data-drop]');
  if (!el || !a.armed) return null;
  if (el.dataset.drop === 'tray' && a.type !== 'part') return null;
  return el;
}

// Where in a day card's list the dragged item would go: in front of the first item
// whose middle is below the finger, or at the end.
function insertAt(card, y, skip) {
  const list = card.querySelector('.parts');
  for (const li of card.querySelectorAll('.parts > .part[data-id]')) {
    if (li.dataset.id === skip) continue;
    const r = li.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { el: li, before: li.dataset.id };
  }
  return { el: list, before: null };
}
function clearInsert() { for (const el of document.querySelectorAll('.ins-before, .ins-end')) el.classList.remove('ins-before', 'ins-end'); }

function moveDrag(x, y) {
  const a = drag.active;
  a.x = x; a.y = y;
  if (!a.armed && Math.hypot(x - a.x0, y - a.y0) > 12) a.armed = true;
  const w = a.ghost.offsetWidth, h = a.ghost.offsetHeight;
  const left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
  const top = Math.max(8, y - h - (a.touch ? 28 : 14));
  a.ghost.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  const t = dropTargetAt(x, y);
  if (t !== a.target) {
    a.target?.classList.remove('drop-on');
    t?.classList.add('drop-on');
    a.target = t;
  }
  // Inside a day card, a line shows where it will go. The strip of days adds to the end.
  const ins = t?.dataset.drop === 'day' && t.classList.contains('card') ? insertAt(t, y, a.item) : null;
  clearInsert();
  if (ins?.el) ins.el.classList.add(ins.before ? 'ins-before' : 'ins-end');
  a.before = ins ? ins.before : undefined;
}

// Scrolls the page when the finger is near the top, or just above the strip of days.
function autoScroll() {
  const a = drag.active;
  if (!a) return;
  const dock = document.querySelector('.dock');
  const bottom = dock ? dock.getBoundingClientRect().top : window.innerHeight;
  let dy = 0;
  if (a.armed && a.y < 90) dy = -Math.ceil((90 - a.y) / 6);
  else if (a.armed && a.y < bottom && a.y > bottom - 70) dy = Math.ceil((a.y - (bottom - 70)) / 6);
  if (dy) { window.scrollBy(0, dy); moveDrag(a.x, a.y); }
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag(apply) {
  const a = drag.active;
  if (!a) return;
  cancelAnimationFrame(drag.raf);
  drag.active = null;
  a.ghost.remove();
  a.src.classList.remove('drag-src');
  a.target?.classList.remove('drop-on');
  clearInsert();
  document.body.classList.remove('dragging', 'drag-goal', 'drag-part');
  if (a.armed) drag.clickBlock = Date.now();
  const t = apply ? a.target : null;
  if (t) {
    if (t.dataset.drop === 'day' && a.type === 'goal') placeGoal(a.item, +t.dataset.day, false, a.before);
    else if (t.dataset.drop === 'day') movePart(a.item, +t.dataset.day, a.before);
    else if (a.type === 'part') removePart(a.item);
  }
  if (ui.pendingRender) render();
}

document.addEventListener('pointerdown', (e) => {
  if (drag.active || drag.pending || e.button > 0 || !e.isPrimary) return;
  const src = e.target.closest?.('[data-drag]');
  if (!src || e.target.closest('input, select, textarea')) return;
  const touch = e.pointerType !== 'mouse';
  const onGrip = !!e.target.closest('.grip');
  drag.pending = { src, id: e.pointerId, x: e.clientX, y: e.clientY, touch, onGrip };
  if (touch && !onGrip) drag.timer = setTimeout(() => { if (drag.pending) startDrag(drag.pending.x, drag.pending.y); }, HOLD_MS);
});
document.addEventListener('pointermove', (e) => {
  const p = drag.pending;
  if (p && e.pointerId === p.id) {
    const far = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (p.touch && !p.onGrip) { if (far > 10) cancelPending(); } // moved before the hold: it's a scroll
    else if (far > 6) startDrag(e.clientX, e.clientY);
    return;
  }
  if (drag.active && e.pointerId === drag.active.id) moveDrag(e.clientX, e.clientY);
});
document.addEventListener('pointerup', (e) => {
  if (drag.pending && e.pointerId === drag.pending.id) cancelPending();
  if (drag.active && e.pointerId === drag.active.id) endDrag(true);
});
document.addEventListener('pointercancel', (e) => {
  if (drag.pending && e.pointerId === drag.pending.id) cancelPending();
  if (drag.active && e.pointerId === drag.active.id) endDrag(false);
});
window.addEventListener('blur', () => { cancelPending(); endDrag(false); });
// While a drag is on, the page must not scroll under the finger.
document.addEventListener('touchmove', (e) => { if ((drag.active || drag.pending?.onGrip) && e.cancelable) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('[data-drag]') && (drag.active || drag.pending)) e.preventDefault(); });
// The tap that ends a drag isn't a click on whatever was under it.
document.addEventListener('click', (e) => { if (Date.now() - drag.clickBlock < 350) { e.stopPropagation(); e.preventDefault(); } }, true);

// ---------- Events ----------
function stopRepeat(p, repeatId, afterWeek) {
  p.repeats = p.repeats.filter((r) => r.id !== repeatId);
  // Later weeks that were filled in automatically and never touched go too.
  if (afterWeek) p.goals = p.goals.filter((g) => !(g.repeatId === repeatId && g.week > afterWeek && !g.parts.length));
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input, select, textarea')) return;
  // Buttons don't take focus on iPhone, so finish any field being edited first.
  const a = document.activeElement;
  const act = el.dataset.act;
  if (a && a !== document.body && a.matches('input[type=text], textarea, select') && act !== 'goal-add') a.blur();
  const s = store.state;
  const { dow, week } = clock();

  switch (act) {
    case 'confirm': ui.confirm = el.dataset.key; render(); break;
    case 'cancel-confirm': ui.confirm = null; render(); break;
    case 'which': ui.which = el.dataset.which; render(); break;
    case 'plan-open':
      ui.which = el.dataset.which;
      if (ui.view === 'plan') render(); else location.hash = '#plan';
      break;

    case 'open-goal': ui.sheet = { goalId: el.dataset.id }; ui.confirm = null; render(); break;
    case 'sheet-close': ui.sheet = null; ui.confirm = null; render(); break;

    case 'edit-classes': ui.schedDay = dow; ui.classForm = null; ui.scrollTarget = 'sched'; location.hash = '#options'; break;
    case 'sched-day': ui.schedDay = +el.dataset.day; ui.classForm = null; ui.confirm = null; render(); break;
    case 'class-new': ui.classForm = { id: 'new', time: '', course: TRACKED[0], label: '', err: null }; ui.confirm = null; render(); break;
    case 'class-edit': {
      const c = s.plan.days[ui.schedDay ?? dow].classes.find((x) => x.id === el.dataset.id); if (!c) break;
      ui.classForm = { id: c.id, time: c.time, course: c.course, label: c.label, err: null }; ui.confirm = null; render();
      break;
    }
    case 'class-cancel': ui.classForm = null; ui.confirm = null; render(); break;
    case 'class-save': {
      const f = ui.classForm; if (!f) break;
      const d = ui.schedDay ?? dow;
      if (!/^\d{1,2}:\d{2}$/.test(f.time)) { f.err = 'Pick a time.'; render(); break; }
      const data = { time: f.time, course: f.course, label: f.label.trim().slice(0, 80) || defaultLabel(f.course) };
      ui.classForm = null; ui.confirm = null;
      commitPlan((p) => {
        const list = p.days[d].classes;
        if (f.id === 'new') list.push({ id: uid(), ...data });
        else Object.assign(list.find((x) => x.id === f.id) || {}, data);
        list.sort((a, b) => toMin(a.time) - toMin(b.time));
      });
      toast(f.id === 'new' ? `Added to ${DAY_NAMES[d]}` : 'Class saved');
      break;
    }
    case 'class-delete': {
      const f = ui.classForm; if (!f) break;
      const d = ui.schedDay ?? dow;
      ui.classForm = null; ui.confirm = null;
      commitPlan((p) => { p.days[d].classes = p.days[d].classes.filter((x) => x.id !== f.id); });
      toast('Class deleted');
      break;
    }

    case 'goal-add': addGoal(); break;
    case 'goal-day': {
      const g = findGoal(s.plan, el.dataset.id); if (!g) break;
      const d = +el.dataset.day;
      const part = g.parts.find((p) => p.day === d);
      if (part) removePart(part.id, true); else placeGoal(g.id, d, true);
      break;
    }
    case 'part-today': movePart(el.dataset.id, dow); break;
    case 'usual': {
      const w = planWeek();
      const todo = weekGoals(s.plan, w).filter((g) => !g.parts.length && !goalDone(s.ticks[w], g) && usualDays(s.plan, g).length).map((g) => [g.id, usualDays(s.plan, g)]);
      const now = Date.now();
      commitPlan((p) => { for (const [id, days] of todo) findGoal(p, id).parts = days.map((d, i) => ({ id: uid() + i, day: d, note: '', at: now + i })); });
      toast(`${plural(todo.length, 'goal')} placed. Drag to change.`);
      break;
    }
    case 'goal-whole': {
      const g = findGoal(s.plan, el.dataset.id); if (!g) break;
      const wt = s.ticks[g.week] || {};
      if (goalDone(wt, g)) commit(tickOp(g.week, g.id, false), ...g.parts.filter((p) => wt[p.id]?.done).map((p) => tickOp(g.week, p.id, false)));
      else { commit(tickOp(g.week, g.id, true)); toast(`${g.title}: done`); }
      break;
    }
    case 'goal-skip': {
      const id = el.dataset.id; ui.sheet = null; ui.confirm = null;
      commitPlan((p) => { const g = findGoal(p, id); g.deleted = true; g.parts = []; });
      toast('Skipped for this week');
      break;
    }
    case 'goal-delete': {
      const id = el.dataset.id; const g = findGoal(s.plan, id); if (!g) break;
      ui.sheet = null; ui.confirm = null;
      commitPlan((p) => {
        if (repeatOf(p, g)) stopRepeat(p, g.repeatId, g.week);
        p.goals = p.goals.filter((x) => x.id !== id);
      });
      toast('Goal deleted');
      break;
    }
    case 'goal-carry': {
      const id = el.dataset.id;
      commitPlan((p) => {
        const g = findGoal(p, id);
        if (g.repeatId) { g.title += ' (last week)'; delete g.repeatId; }
        g.week = week; g.parts = [];
      });
      toast('Moved to this week. Put it on a day.');
      break;
    }
    case 'goal-drop': commitPlan((p) => { const g = findGoal(p, el.dataset.id); g.deleted = true; }); toast('Dropped'); break;
    case 'repeat-stop': { const id = el.dataset.id; ui.confirm = null; commitPlan((p) => stopRepeat(p, id, null)); toast('Stopped repeating'); break; }

    case 'demo-reset': LS.del(PRE + 'state'); store.state = null; ui.confirm = null; await pull(); toast('Preview cleared'); break;
    case 'sync-now': ui.msgs.sync = null; await pull(); toast(ui.sync === 'ok' ? 'Synced' : 'Couldn’t sync'); break;
    case 'signout':
      if (ui.push === 'on') await pushOff();
      for (const k of ['sp-key', 'sp-state', 'sp-outbox']) LS.del(k);
      store.key = null; store.state = null; store.outbox = []; ui.confirm = null; location.hash = '#setup'; render();
      break;

    case 'push-on': await pushOn(); break;
    case 'push-off': await pushOff(); break;
    case 'push-test': await pushTest(); break;

    case 'copy': {
      const val = el.dataset.val;
      try { await navigator.clipboard.writeText(val); toast('Copied'); }
      catch { const code = el.closest('.keybox').querySelector('code'); const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected. Copy it from the menu.'); }
      break;
    }
    case 'setup-gen': case 'setup-regen': {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      LS.set('sp-pending', { APP_KEY: b64u(crypto.getRandomValues(new Uint8Array(32))), VAPID_PUBLIC: pub, VAPID_PRIVATE: jwk.d });
      ui.msgs.setup = null; render();
      break;
    }
    case 'setup-done': await connectWithKey(LS.get('sp-pending', {}).APP_KEY, true); break;
    case 'setup-connect': {
      const k = document.getElementById('k-input').value.trim();
      if (!k) { ui.msgs.setup = 'Paste your APP_KEY first.'; ui.msgs.setupOk = false; render(); return; }
      document.activeElement?.blur();
      await connectWithKey(k, false);
      break;
    }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const s = store.state;
  if (act === 'tick') {
    const { week, item } = el.dataset;
    const g = findGoal(s.plan, el.dataset.goal);
    const wt = s.ticks[week] || {};
    const was = g && goalDone(wt, g);
    const ops = [];
    // The goal was marked done as a whole: unticking one day keeps the other days ticked.
    if (g && !el.checked && wt[g.id]?.done) ops.push(tickOp(week, g.id, false), ...g.parts.filter((p) => p.id !== item).map((p) => tickOp(week, p.id, true)));
    ops.push(tickOp(week, item, el.checked));
    commit(...ops);
    if (el.checked && g && !was && goalDone(store.state.ticks[week], g)) toast(g.parts.length > 1 ? `${g.title}: all ${g.parts.length} parts done` : `${g.title}: done`);
  } else if (act === 'add-course') {
    ui.addCourse = el.value;
  } else if (act === 'day-hours') {
    const d = +el.dataset.day; const v = el.value.trim().slice(0, 60);
    if (v === s.plan.days[d].hours) return;
    holdRender();
    commitPlan((p) => { p.days[d].hours = v; });
  } else if (act === 'add-repeat') {
    ui.addRepeat = el.checked;
  } else if (act === 'goal-title' || act === 'goal-course') {
    const id = el.dataset.id; const g = findGoal(s.plan, id); if (!g) return;
    const key = act === 'goal-title' ? 'title' : 'course';
    const v = key === 'title' ? el.value.trim().slice(0, 120) : el.value;
    if ((key === 'title' && !v) || v === g[key]) { el.value = g[key]; return; }
    if (key === 'title') holdRender();
    commitPlan((p) => {
      const x = findGoal(p, id); x[key] = v;
      const r = repeatOf(p, x);
      if (r) { r[key] = v; for (const y of p.goals) if (y.repeatId === r.id && y.week > x.week) y[key] = v; }
    });
  } else if (act === 'part-note') {
    const id = el.dataset.id; const v = el.value.trim().slice(0, 120);
    if (findPart(s.plan, id)?.p.note === v) return;
    holdRender();
    commitPlan((p) => { const f = findPart(p, id); if (f) f.p.note = v; });
  } else if (act === 'goal-repeat') {
    const id = el.dataset.id; const g = findGoal(s.plan, id); if (!g) return;
    if (el.checked) {
      commitPlan((p) => {
        const x = findGoal(p, id);
        const r = { id: uid(), title: x.title, course: x.course, since: addDays(x.week, 7), usual: sortedParts(x).map((q) => q.day) };
        p.repeats.push(r); x.repeatId = r.id;
      });
      toast('It comes back every week');
    } else if (g.repeatId) {
      commitPlan((p) => { stopRepeat(p, g.repeatId, g.week); delete findGoal(p, id).repeatId; });
      toast('Stopped repeating');
    }
  } else if (act === 'reminder-time') {
    const [h, m] = el.value.split(':').map(Number);
    if (!Number.isFinite(h)) return;
    const q = Math.round(m / 15) * 15;
    const hh = (q === 60 ? h + 1 : h) % 24, mm = q % 60;
    const v = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    commitSettings((st) => { (st.reminders ||= { ...DEFAULT_SETTINGS.reminders })[el.dataset.key] = v; });
  } else if (act === 'reminders-off') {
    commitSettings((st) => { (st.reminders ||= { ...DEFAULT_SETTINGS.reminders }).off = el.checked; });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'g-title') ui.addTitle = el.value;
  else if (el.dataset?.act === 'cf' && ui.classForm) {
    ui.classForm[el.dataset.k] = el.dataset.k === 'time' ? unpadTime(el.value) : el.value;
    if (el.dataset.k === 'course') { const lab = document.getElementById('c-label'); if (lab) lab.placeholder = defaultLabel(el.value); }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.target.id === 'g-title') { e.preventDefault(); addGoal(); }
  else if (e.key === 'Enter' && e.target.matches?.('.sheet input[type=text]')) e.target.blur();
  else if (e.key === 'Escape' && ui.sheet) { document.activeElement?.blur(); ui.sheet = null; ui.confirm = null; render(); }
});

function route() {
  const v = location.hash.replace('#', '').replace('options', 'settings');
  ui.view = ['today', 'plan', 'settings', 'setup'].includes(v) ? v : 'today';
  ui.confirm = null; ui.sheet = null;
  if (ui.view !== 'settings') ui.classForm = null;
  if (ui.view === 'settings' && !DEMO) refreshPushState().then(render);
  render();
  scrollTo(0, 0);
  if (ui.scrollTarget) { document.getElementById(ui.scrollTarget)?.scrollIntoView({ block: 'start' }); ui.scrollTarget = null; }
}

// A new day (or a new week) started while the app was open.
function newDay() {
  const { today } = clock();
  if (ui.lastDate === today) return false;
  ui.lastDate = today; ui.which = null;
  if (store.state) { prepare(store.state); save(); }
  return true;
}

window.addEventListener('hashchange', route);
window.addEventListener('online', () => pull());
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  newDay();
  pull();
});
setInterval(() => { if (newDay()) render(); }, 60000);

if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
ui.lastDate = clock().today;
if (store.state) prepare(store.state);
route();
if (!DEMO) refreshPushState();
pull();
