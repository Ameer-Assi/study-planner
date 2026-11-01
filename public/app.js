import {
  COURSES, TRACKED, DAY_NAMES, DEFAULT_PLAN, nowLocal, addDays, daysBetween, weekOf, fmtShortDate,
  overdueItems, required, deadlineStatus, upcomingExams, inExamMode, examPrep,
} from './shared.js';

const VERSION = '1.0.0';

// ---------- Storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const store = {
  key: LS.get('sp-key', null),
  state: LS.get('sp-state', null),
  outbox: LS.get('sp-outbox', []),
};
const ui = {
  view: 'week', day: null, editing: false, editId: null, confirm: null,
  sync: 'idle', showWeek: false, push: null, msgs: {}, pendingRender: false, lastDate: null,
};
const save = () => { LS.set('sp-state', store.state); LS.set('sp-outbox', store.outbox); };

// ---------- Helpers ----------
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cname = (k) => COURSES[k]?.name || k;
const sw = (k) => (k === 'any' ? '<span class="sw dash"></span>' : `<span class="sw" style="--c:var(--${esc(k)})"></span>`);
const uid = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clock = () => { const L = nowLocal(); return { today: L.date, dow: L.dow, week: weekOf(L.date), hm: L.hm }; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ICON_WARN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>';
const ICON_CLOCK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

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

function dueText(due, today) {
  const n = daysBetween(today, due);
  if (n < 0) return `${plural(-n, 'day')} late`;
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  return `due ${DAY_NAMES[new Date(due + 'T12:00:00Z').getUTCDay()].slice(0, 3)} ${fmtShortDate(due)} · in ${n} days`;
}

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
  for (const t of d.ticks) (ticks[t.week] ||= {})[t.item] = { done: !!t.done, effort: t.effort, updated: t.updated };
  const deadlines = {};
  for (const x of d.deadlines) deadlines[x.id] = { ...x, deleted: !!x.deleted };
  return {
    plan: d.plan, planUpdated: d.planUpdated, settings: d.settings, settingsUpdated: d.settingsUpdated,
    ticks, deadlines, vapidPublic: d.vapidPublic,
  };
}

function applyOp(s, op) {
  if (op.type === 'tick') (s.ticks[op.week] ||= {})[op.item] = { done: op.done, effort: op.effort, updated: op.updated };
  else if (op.type === 'deadline') s.deadlines[op.id] = { id: op.id, course: op.course, title: op.title, due: op.due, progress: op.progress, deleted: !!op.deleted, updated: op.updated };
  else if (op.type === 'plan') { s.plan = op.plan; s.planUpdated = op.updated; }
  else if (op.type === 'settings') { s.settings = op.settings; s.settingsUpdated = op.updated; }
}

function setSync(state) { ui.sync = state; const el = document.querySelector('.sync'); if (el) el.outerHTML = syncHTML(); }

let flushing = false;
async function flush() {
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
  if (!navigator.onLine) { setSync('offline'); render(); return; }
  if (!store.state) setSync('loading');
  try {
    await flush();
    const d = await api('/api/state?weeks=12');
    const s = fromServer(d);
    for (const op of store.outbox) applyOp(s, op);
    store.state = s; save();
    setSync(store.outbox.length ? 'pending' : 'ok');
  } catch (e) {
    setSync(e.status === 401 ? 'auth' : navigator.onLine ? 'error' : 'offline');
    ui.msgs.sync = e.message;
  }
  render();
}

function commit(op) {
  op.updated = Date.now();
  applyOp(store.state, op);
  store.outbox.push(op);
  save();
  if (ui.sync === 'ok') ui.sync = 'pending';
  render();
  flush();
}

function commitPlan(mutator) {
  const plan = structuredClone(store.state.plan);
  mutator(plan);
  commit({ type: 'plan', plan });
}
function commitSettings(mutator) {
  const settings = structuredClone(store.state.settings);
  mutator(settings);
  commit({ type: 'settings', settings });
}

// Ticking "Homework to 60%" moves the nearest open deadline of that course up to 60%.
function bumpDeadline(course, hw) {
  const { today } = clock();
  const open = Object.values(store.state.deadlines)
    .filter((d) => !d.deleted && d.course === course && d.progress < 100 && daysBetween(today, d.due) >= -7)
    .sort((a, b) => a.due.localeCompare(b.due));
  const d = open[0];
  if (d && d.progress < hw) {
    commit({ type: 'deadline', ...d, progress: hw });
    toast(`${d.title} is now at ${hw}%`);
  }
}

// ---------- Rendering ----------
function syncHTML() {
  const map = {
    ok: 'Synced', pending: `Saving ${store.outbox.length}`, offline: 'Offline', error: 'Sync failed',
    auth: 'Key rejected', loading: 'Loading', idle: '',
  };
  const cls = ui.sync === 'ok' ? '' : ui.sync === 'pending' || ui.sync === 'loading' ? 'pending' : ui.sync === 'offline' ? 'offline' : 'error';
  return `<span class="sync ${cls}" role="status"><i></i>${map[ui.sync] ?? ''}</span>`;
}

function headerHTML(title, sub) {
  return `<header class="top"><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>${syncHTML()}</header>`;
}

function examStripHTML() {
  const { today } = clock();
  const ex = upcomingExams(store.state.settings, today).slice(0, 8);
  if (!ex.length) return '';
  return `<div class="exams" aria-label="Exam countdown">${ex.map((e) => {
    const n = daysBetween(today, e.date);
    return `<span class="chip ${n <= 7 ? 'near' : ''}">${sw(e.course)}${esc(COURSES[e.course]?.short || e.course)}${e.moed === 'B' ? ' B' : ''} <b>${n === 0 ? 'today' : n + 'd'}</b></span>`;
  }).join('')}</div>`;
}

function effortHTML(week, item, effort) {
  const opt = [[-1, 'Less'], [0, 'As planned'], [1, 'More']];
  return `<div class="effort"><span>Effort</span>${opt.map(([v, l]) =>
    `<button type="button" class="seg" data-act="effort" data-week="${esc(week)}" data-item="${esc(item)}" data-v="${v}" aria-pressed="${effort === v}">${l}</button>`).join('')}</div>`;
}

function itemHTML(item, week, opts = {}) {
  const t = store.state.ticks[week]?.[item.id];
  const done = !!t?.done;
  return `<li class="item${item.optional ? ' optional' : ''}${done ? ' done' : ''}">
    <input type="checkbox" class="check" id="chk-${esc(week)}-${esc(item.id)}" data-act="tick" data-week="${esc(week)}" data-item="${esc(item.id)}"${done ? ' checked' : ''} aria-label="${esc(cname(item.course))}: ${esc(item.tasks[0] || '')}">
    <div class="item-body">
      <div class="meta">${sw(item.course)}<span class="c">${esc(cname(item.course))}</span><span class="when">${esc(opts.when ?? item.when)}</span>${item.optional ? '<span class="tag">optional</span>' : ''}${opts.late ? '<span class="tag late">late</span>' : ''}</div>
      <ul class="tasks">${item.tasks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${done && !item.optional && item.course !== 'flex' && opts.effort !== false ? effortHTML(week, item.id, t.effort ?? null) : ''}
    </div>
  </li>`;
}

function alertsHTML() {
  const s = store.state;
  const { today, dow, week } = clock();
  let h = '';

  const urgent = Object.values(s.deadlines).filter((d) => !d.deleted && ['soon', 'late'].includes(deadlineStatus(d, today)))
    .sort((a, b) => a.due.localeCompare(b.due));
  if (urgent.length) {
    const late = urgent.some((d) => deadlineStatus(d, today) === 'late');
    h += `<section class="card alert${late ? ' bad' : ''}"><h2>${ICON_CLOCK}Deadlines close</h2><ul class="list">${urgent.map((d) => `
      <li><div class="grow"><div class="meta">${sw(d.course)}<span class="c">${esc(d.title)}</span></div>
      <div class="small">${esc(dueText(d.due, today))} · at ${d.progress}%</div></div></li>`).join('')}</ul>
      <div class="row"><a class="btn" href="#deadlines">Update progress</a></div></section>`;
  }

  const behind = overdueItems(s.plan, s.ticks[week], dow);
  if (behind.length) {
    h += `<section class="card alert"><div class="card-head"><h2>${ICON_WARN}Behind this week</h2><span class="small muted">${plural(behind.length, 'target')}</span></div>
      <ul class="items">${behind.map(({ day, item }) => itemHTML(item, week, { when: DAY_NAMES[day], late: false, effort: false })).join('')}</ul>
      <p class="small muted">Thursday’s catch-up block is for these.</p></section>`;
  }

  if (dow <= 2) {
    const prev = addDays(week, -7);
    const pt = s.ticks[prev];
    if (pt && Object.keys(pt).length && !pt.__dismissed?.done) {
      const left = overdueItems(s.plan, pt, 7);
      if (left.length) {
        h += `<section class="card alert"><div class="card-head"><h2>${ICON_WARN}Left from last week</h2><span class="small muted">${plural(left.length, 'target')}</span></div>
          <ul class="items">${left.map(({ day, item }) => itemHTML(item, prev, { when: DAY_NAMES[day], effort: false })).join('')}</ul>
          <div class="row"><button type="button" class="btn" data-act="dismiss-leftovers" data-week="${prev}">Clear this list</button></div></section>`;
      }
    }
  }
  return h;
}

function tabsHTML() {
  const s = store.state;
  const { dow, week } = clock();
  const wt = s.ticks[week] || {};
  return `<div class="tabs" role="tablist" aria-label="Days">${s.plan.days.map((d, i) => {
    const req = required(d.items);
    const done = req.filter((x) => wt[x.id]?.done).length;
    const missed = i < dow ? req.length - done : 0;
    return `<button type="button" role="tab" id="tab-${i}" class="tab${i === dow ? ' today' : ''}${req.length && done === req.length ? ' full' : ''}" aria-selected="${i === ui.day}" data-act="day" data-day="${i}">
      <span class="d">${DAY_NAMES[i].slice(0, 3)}</span><span class="p">${done}/${req.length}</span>${missed ? `<span class="badge" aria-label="${missed} missed">${missed}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

function courseOptions(selected, includeMeta = true) {
  return Object.keys(COURSES).filter((k) => includeMeta || COURSES[k].track)
    .map((k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(COURSES[k].name)}</option>`).join('');
}

function itemFormHTML(item) {
  const isNew = !item;
  item ||= { course: 'sig', when: '', tasks: [], optional: false, hw: null };
  return `<div class="editbox" data-form="item" data-id="${isNew ? 'new' : esc(item.id)}">
    <div class="row">
      <label class="field"><span>Course</span><select id="f-course">${courseOptions(item.course)}</select></label>
      <label class="field"><span>When</span><input type="text" id="f-when" value="${esc(item.when)}" placeholder="morning"></label>
    </div>
    <label class="field"><span>What to do, one per line</span><textarea id="f-tasks" placeholder="Homework to 50%">${esc(item.tasks.join('\n'))}</textarea></label>
    <div class="row">
      <label class="field" style="max-width:150px"><span>Homework % reached</span><input type="number" id="f-hw" min="0" max="100" step="5" value="${item.hw ?? ''}" placeholder="none"></label>
      <label class="toggle"><input type="checkbox" id="f-opt"${item.optional ? ' checked' : ''}> Optional (6:30 start)</label>
    </div>
    <p class="msg err" id="f-err" hidden></p>
    <div class="row end"><button type="button" class="btn ghost" data-act="cancel-edit">Cancel</button><button type="button" class="btn primary" data-act="save-item">${isNew ? 'Add target' : 'Save'}</button></div>
  </div>`;
}

function dayCardHTML() {
  const s = store.state;
  const { week } = clock();
  const i = ui.day;
  const d = s.plan.days[i];
  const wt = s.ticks[week] || {};
  const req = required(d.items);
  const done = req.filter((x) => wt[x.id]?.done).length;

  if (ui.editing) {
    return `<section class="card" role="tabpanel" aria-labelledby="tab-${i}">
      <div class="card-head"><h2>Edit ${DAY_NAMES[i]}</h2><button type="button" class="btn primary" data-act="stop-edit">Done</button></div>
      <label class="field"><span>Hours</span><input type="text" id="f-hours" data-act="hours" value="${esc(d.hours)}"></label>
      <p class="label">Classes</p>
      <ul class="list">${d.classes.map((c) => `<li><span class="mono small muted" style="width:40px">${esc(c.time)}</span>${sw(c.course)}<span class="grow">${esc(c.label)}</span>
        ${ui.confirm === 'cls-' + c.id
          ? `<button type="button" class="btn danger" data-act="del-class" data-id="${esc(c.id)}">Delete</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button>`
          : `<button type="button" class="btn ghost" data-act="confirm" data-key="cls-${esc(c.id)}" aria-label="Delete class">Delete</button>`}</li>`).join('') || '<li class="muted small">No classes.</li>'}</ul>
      ${ui.editId === 'new-class' ? `<div class="editbox" data-form="class">
        <div class="row"><label class="field" style="max-width:110px"><span>Time</span><input type="text" id="fc-time" placeholder="9:30"></label>
        <label class="field"><span>Course</span><select id="fc-course">${courseOptions('sig', false)}</select></label></div>
        <label class="field"><span>Label</span><input type="text" id="fc-label" placeholder="Signals lecture"></label>
        <p class="msg err" id="fc-err" hidden></p>
        <div class="row end"><button type="button" class="btn ghost" data-act="cancel-edit">Cancel</button><button type="button" class="btn primary" data-act="save-class">Add class</button></div></div>`
        : '<div class="row"><button type="button" class="btn" data-act="edit" data-id="new-class">Add class</button></div>'}
      <p class="label">Targets</p>
      <ul class="list">${d.items.map((it) => ui.editId === it.id ? `<li style="display:block">${itemFormHTML(it)}</li>` : `<li>
        <div class="grow"><div class="meta">${sw(it.course)}<span class="c">${esc(cname(it.course))}</span><span class="when">${esc(it.when)}</span>${it.optional ? '<span class="tag">optional</span>' : ''}${it.hw != null ? `<span class="tag">HW ${it.hw}%</span>` : ''}</div>
        <ul class="tasks">${it.tasks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="row" style="flex-direction:column;gap:2px">
          <button type="button" class="btn ghost" data-act="edit" data-id="${esc(it.id)}">Edit</button>
          ${ui.confirm === 'item-' + it.id
            ? `<button type="button" class="btn danger" data-act="del-item" data-id="${esc(it.id)}">Delete</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button>`
            : `<button type="button" class="btn ghost" data-act="confirm" data-key="item-${esc(it.id)}">Delete</button>`}
        </div></li>`).join('')}</ul>
      ${ui.editId === 'new' ? itemFormHTML(null) : '<div class="row"><button type="button" class="btn" data-act="edit" data-id="new">Add target</button></div>'}
    </section>`;
  }

  return `<section class="card" role="tabpanel" aria-labelledby="tab-${i}">
    <div class="card-head"><h2>${DAY_NAMES[i]} <span class="muted small mono" style="font-weight:400">${esc(d.hours)}</span></h2>
      <div class="row"><span class="mono small muted">${done}/${req.length}</span><button type="button" class="btn ghost" data-act="start-edit">Edit</button></div></div>
    ${d.classes.length ? `<p class="label">Classes</p><ul class="classes">${d.classes.map((c) => `<li><span class="t">${esc(c.time)}</span>${sw(c.course)}<span>${esc(c.label)}</span></li>`).join('')}</ul>` : ''}
    <p class="label">Targets</p>
    ${d.items.length ? `<ul class="items">${d.items.map((it) => itemHTML(it, week)).join('')}</ul>` : '<p class="muted small">Nothing planned. Tap Edit to add a target.</p>'}
  </section>`;
}

function examCardHTML() {
  const { today } = clock();
  const p = examPrep(store.state.settings, today);
  if (!p) return '';
  const c = p.exam.course;
  return `<section class="card">
    <p class="label">Exam prep</p>
    <div class="exam-big"><span class="big">${p.daysLeft === 0 ? 'Today' : p.daysLeft}</span><span>${p.daysLeft === 0 ? '' : p.daysLeft === 1 ? 'day until' : 'days until'} <b>${esc(cname(c))}</b>${p.exam.moed === 'B' ? ' (Moed B)' : ''}</span></div>
    <div><span class="phase" style="--c:var(--${esc(c)})">${esc(p.phase)}</span> <span class="small muted">day ${p.index + 1} of ${p.total} for this exam</span></div>
    <ul class="items">${p.tasks.map((t, k) => itemHTML({ id: `${today}-${k}`, course: c, when: 'today', tasks: [t], optional: false }, 'exam', { effort: false })).join('')}</ul>
    <div class="row"><button type="button" class="btn" data-act="toggle-week">${ui.showWeek ? 'Hide the weekly plan' : 'Show the weekly plan'}</button></div>
  </section>`;
}

function viewWeek() {
  const s = store.state;
  const { today, dow } = clock();
  if (ui.day == null) ui.day = dow;
  let h = headerHTML(DAY_NAMES[dow], fmtShortDate(today));
  if (ui.sync === 'auth') h += `<section class="card alert bad"><h2>${ICON_WARN}App key rejected</h2><p class="small">The server didn’t accept this device’s key. Check APP_KEY in Cloudflare, or sign out in Settings and enter it again.</p></section>`;
  h += examStripHTML();
  if (inExamMode(s.settings, today)) {
    h += examCardHTML();
    if (!ui.showWeek) return h;
  }
  h += alertsHTML() + tabsHTML() + dayCardHTML();
  return h;
}

function viewDeadlines() {
  const s = store.state;
  const { today } = clock();
  const all = Object.values(s.deadlines).filter((d) => !d.deleted);
  const open = all.filter((d) => d.progress < 100).sort((a, b) => a.due.localeCompare(b.due));
  const done = all.filter((d) => d.progress >= 100).sort((a, b) => b.due.localeCompare(a.due)).slice(0, 10);
  const row = (d) => {
    const st = deadlineStatus(d, today);
    return `<li><div class="grow">
      <div class="meta">${sw(d.course)}<span class="dl-title">${esc(d.title)}</span><span class="muted">${esc(cname(d.course))}</span></div>
      <div class="dl-due ${st}">${esc(dueText(d.due, today))}</div>
      <div class="bar" style="--c:var(--${esc(d.course)})"><i style="width:${d.progress}%"></i></div>
      <div class="steps">${[0, 25, 50, 75, 100].map((v) => `<button type="button" class="seg" data-act="progress" data-id="${esc(d.id)}" data-v="${v}" aria-pressed="${d.progress === v}">${v}%</button>`).join('')}</div>
    </div>
    ${ui.confirm === 'dl-' + d.id
      ? `<div class="row" style="flex-direction:column;gap:2px"><button type="button" class="btn danger" data-act="del-deadline" data-id="${esc(d.id)}">Delete</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep</button></div>`
      : `<button type="button" class="btn ghost" data-act="confirm" data-key="dl-${esc(d.id)}" aria-label="Delete ${esc(d.title)}">Delete</button>`}
    </li>`;
  };
  return headerHTML('Deadlines', 'Real due dates for homework and assignments') + `
    <section class="card" data-form="deadline">
      <h2>Add a deadline</h2>
      <div class="row">
        <label class="field"><span>Course</span><select id="d-course">${courseOptions('sig', false)}</select></label>
        <label class="field"><span>Due</span><input type="date" id="d-due" min="${today}"></label>
      </div>
      <label class="field"><span>Name</span><input type="text" id="d-title" placeholder="Signals HW 3"></label>
      <p class="msg err" id="d-err" hidden></p>
      <div class="row end"><button type="button" class="btn primary" data-act="add-deadline">Add deadline</button></div>
    </section>
    <section class="card"><div class="card-head"><h2>Open</h2><span class="small muted">${open.length}</span></div>
      ${open.length ? `<ul class="list">${open.map(row).join('')}</ul>` : '<p class="muted small">No open deadlines. Add each assignment when it’s published.</p>'}
      <p class="small muted">Ticking a target like “Homework to 60%” raises the nearest deadline for that course to 60%.</p>
    </section>
    ${done.length ? `<section class="card"><h2>Finished</h2><ul class="list">${done.map((d) => `<li><div class="grow"><div class="meta">${sw(d.course)}<span class="c">${esc(d.title)}</span></div><div class="dl-due">${esc(fmtShortDate(d.due))}</div></div><button type="button" class="btn ghost" data-act="progress" data-id="${esc(d.id)}" data-v="75">Reopen</button></li>`).join('')}</ul></section>` : ''}`;
}

function viewStats() {
  const s = store.state;
  const { week } = clock();
  const weeks = Array.from({ length: 8 }, (_, k) => addDays(week, -7 * (7 - k)));
  const reqBy = {};
  s.plan.days.forEach((d) => required(d.items).forEach((it) => { (reqBy[it.course] ||= []).push(it.id); }));
  const pct = (c, w) => {
    const ids = reqBy[c] || []; if (!ids.length) return null;
    const t = s.ticks[w] || {};
    return Math.round(100 * ids.filter((id) => t[id]?.done).length / ids.length);
  };
  const allReq = Object.values(reqBy).flat();
  const thisDone = allReq.filter((id) => s.ticks[week]?.[id]?.done).length;
  const used = weeks.filter((w) => s.ticks[w] && Object.keys(s.ticks[w]).length);
  const courses = TRACKED.filter((c) => reqBy[c]);

  const recent = weeks.slice(-4);
  const effort = {};
  for (const c of courses) {
    const e = { less: 0, same: 0, more: 0 };
    for (const w of recent) for (const id of reqBy[c]) {
      const v = s.ticks[w]?.[id]?.effort;
      if (v === -1) e.less++; else if (v === 0) e.same++; else if (v === 1) e.more++;
    }
    effort[c] = e;
  }
  const heavy = courses.filter((c) => effort[c].more >= 3 && effort[c].more > effort[c].same + effort[c].less);
  const light = courses.filter((c) => effort[c].less >= 3 && effort[c].less > effort[c].same + effort[c].more);
  const avg = (c) => {
    const ws = recent.slice(0, -1).filter((w) => used.includes(w));
    if (!ws.length) return null;
    return Math.round(ws.reduce((a, w) => a + pct(c, w), 0) / ws.length);
  };

  return headerHTML('Stats', 'Required targets only') + `
    <section class="card"><p class="label">This week</p>
      <div class="stats-row"><div><div class="big">${allReq.length ? Math.round(100 * thisDone / allReq.length) : 0}%</div><div class="small muted">${thisDone} of ${allReq.length} targets</div></div></div>
    </section>
    <section class="card"><h2>Completion by course</h2>
      <div style="overflow-x:auto"><div class="chart" style="--n:${weeks.length}">
        ${courses.map((c) => `<span class="rl">${esc(COURSES[c].short)}</span>${weeks.map((w) => {
          const p = pct(c, w) ?? 0;
          return `<span class="cell${w === week ? ' now' : ''}" title="${esc(cname(c))}, week of ${fmtShortDate(w)}: ${p}%" style="--c:var(--${c})"><i style="height:${p}%"></i></span>`;
        }).join('')}`).join('')}
        <span></span>${weeks.map((w) => `<span class="wk">${fmtShortDate(w).split(' ')[0]}</span>`).join('')}
      </div></div>
      <p class="small muted">Each column is a week, labeled by its Sunday. The outlined column is this week.</p>
      ${courses.some((c) => avg(c) != null) ? `<p class="small">Last 3 weeks: ${courses.map((c) => `${COURSES[c].short} ${avg(c) ?? '–'}%`).join(' · ')}</p>` : ''}
    </section>
    <section class="card"><h2>Effort, last 4 weeks</h2>
      <table class="effort-table"><thead><tr><th>Course</th><th>Less</th><th>As planned</th><th>More</th></tr></thead><tbody>
        ${courses.map((c) => `<tr><td>${sw(c)} ${esc(cname(c))}</td><td>${effort[c].less}</td><td>${effort[c].same}</td><td class="${heavy.includes(c) ? 'hi' : ''}">${effort[c].more}</td></tr>`).join('')}
      </tbody></table>
      ${heavy.length ? `<p class="small">${heavy.map(cname).join(', ')} keep${heavy.length === 1 ? 's' : ''} taking more than planned. Consider splitting the homework over one more day.</p>` : ''}
      ${light.length ? `<p class="small">${light.map(cname).join(', ')} keep${light.length === 1 ? 's' : ''} taking less than planned. You could merge two of its targets.</p>` : ''}
      ${!heavy.length && !light.length ? '<p class="small muted">Tag effort on finished targets. After a few weeks this shows which courses need more time.</p>' : ''}
    </section>`;
}

function timeField(id, label, value) {
  return `<label class="field"><span>${label}</span><input type="time" id="${id}" step="900" value="${esc(value)}" data-act="reminder-time" data-key="${id.replace('r-', '')}"></label>`;
}

function viewSettings() {
  const s = store.state;
  const r = s.settings.reminders;
  const push = ui.push;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let pushLine;
  if (!s.vapidPublic) pushLine = 'The server has no notification keys yet. Add VAPID_PUBLIC and VAPID_PRIVATE in Cloudflare.';
  else if (!('PushManager' in window)) pushLine = standalone ? 'This browser doesn’t support notifications.' : 'On iPhone, add this app to your Home Screen first, then open it from there to turn on reminders.';
  else if (push === 'on') pushLine = 'Reminders are on for this device.';
  else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') pushLine = 'Notifications are blocked. Allow them in your phone’s settings for this app.';
  else pushLine = 'Reminders are off on this device.';

  const exams = [...s.settings.exams].sort((a, b) => a.moed.localeCompare(b.moed) || a.date.localeCompare(b.date));
  return headerHTML('Settings', '') + `
    <section class="card"><h2>Reminders</h2>
      <p class="small">${esc(pushLine)}</p>
      <div class="row">
        ${push === 'on'
          ? '<button type="button" class="btn" data-act="push-test">Send a test</button><button type="button" class="btn ghost" data-act="push-off">Turn off on this device</button>'
          : `<button type="button" class="btn primary" data-act="push-on"${!s.vapidPublic || !('PushManager' in window) ? ' disabled' : ''}>Turn on reminders</button>`}
      </div>
      ${ui.msgs.push ? `<p class="msg">${esc(ui.msgs.push)}</p>` : ''}
      <div class="row">${timeField('r-morning', 'Morning summary', r.morning)}${timeField('r-evening', 'Evening nudge', r.evening)}</div>
      <div class="row">${timeField('r-weekendMorning', 'Fri–Sat morning', r.weekendMorning)}${timeField('r-weekendEvening', 'Fri–Sat nudge', r.weekendEvening)}</div>
      <label class="toggle"><input type="checkbox" id="r-off" data-act="reminders-off"${r.off ? ' checked' : ''}> Pause all reminders</label>
      <p class="small muted">Israel time, in 15-minute steps. The evening nudge only comes if targets are still open. The morning summary includes anything behind and close deadlines.</p>
    </section>
    <section class="card"><h2>Semester</h2>
      <label class="field" style="max-width:220px"><span>Last day of classes</span><input type="date" id="s-end" data-act="semester-end" value="${esc(s.settings.semesterEnd)}"></label>
      <p class="small muted">The day after, the Week screen switches to exam prep. Check this date in the Technion calendar.</p>
    </section>
    <section class="card"><h2>Exams</h2>
      <ul class="list">${exams.map((e) => `<li style="align-items:center">
        <label class="toggle grow">${'<input type="checkbox" data-act="exam-taking" data-id="' + esc(e.id) + '"' + (e.taking ? ' checked' : '') + '>'}${sw(e.course)}<span>${esc(COURSES[e.course]?.short || e.course)} <span class="muted">· Moed ${esc(e.moed)}</span></span></label>
        <input type="date" style="max-width:160px" id="ex-${esc(e.id)}" data-act="exam-date" data-id="${esc(e.id)}" value="${esc(e.date)}" aria-label="${esc(cname(e.course))} Moed ${esc(e.moed)} date">
      </li>`).join('')}</ul>
      <p class="small muted">Ticked exams appear in the countdown and drive exam prep. Tick a Moed B if you’ll take it.</p>
    </section>
    <section class="card"><h2>Weekly plan</h2>
      <p class="small muted">Edit any day from the Week screen. Resetting brings back the original plan, but keeps your ticks.</p>
      <div class="row">${ui.confirm === 'reset-plan'
        ? '<button type="button" class="btn danger" data-act="reset-plan">Reset the plan</button><button type="button" class="btn ghost" data-act="cancel-confirm">Keep my plan</button>'
        : '<button type="button" class="btn" data-act="confirm" data-key="reset-plan">Reset to the original plan</button>'}</div>
    </section>
    <section class="card"><h2>This device</h2>
      <div class="row"><button type="button" class="btn" data-act="sync-now">Sync now</button>${syncHTML()}</div>
      ${ui.msgs.sync && ui.sync !== 'ok' ? `<p class="msg err">${esc(ui.msgs.sync)}</p>` : ''}
      <div class="row">${ui.confirm === 'signout'
        ? '<button type="button" class="btn danger" data-act="signout">Sign out and clear this device</button><button type="button" class="btn ghost" data-act="cancel-confirm">Cancel</button>'
        : '<button type="button" class="btn ghost" data-act="confirm" data-key="signout">Sign out</button>'}</div>
      <p class="small muted">Version ${VERSION}. Your data lives in your Cloudflare database and syncs to every device with the app key.</p>
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
  location.hash = '#week';
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
  const a = document.activeElement;
  if (a && $app.contains(a) && (a.matches('input[type=text], input[type=password], input[type=number], textarea, select'))) {
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
  const views = { week: viewWeek, deadlines: viewDeadlines, stats: viewStats, settings: viewSettings, setup: viewSetup };
  $app.innerHTML = (views[view] || viewWeek)();
}
$app.addEventListener('focusout', () => setTimeout(() => { if (ui.pendingRender) render(); }, 0));

// ---------- Events ----------
function readItemForm(box) {
  const tasks = box.querySelector('#f-tasks').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const hwRaw = box.querySelector('#f-hw').value.trim();
  const hw = hwRaw === '' ? null : Math.max(0, Math.min(100, Math.round(+hwRaw)));
  return {
    course: box.querySelector('#f-course').value,
    when: box.querySelector('#f-when').value.trim(),
    tasks, hw: Number.isFinite(hw) ? hw : null,
    optional: box.querySelector('#f-opt').checked,
  };
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input[type=checkbox], input[type=date], input[type=time], input[type=text]')) return;
  const act = el.dataset.act;
  const s = store.state;
  const { today } = clock();

  switch (act) {
    case 'day': ui.day = +el.dataset.day; ui.editing = false; ui.editId = null; render(); break;
    case 'start-edit': ui.editing = true; ui.editId = null; ui.confirm = null; render(); break;
    case 'stop-edit': ui.editing = false; ui.editId = null; ui.confirm = null; render(); break;
    case 'edit': ui.editId = el.dataset.id; ui.confirm = null; render(); break;
    case 'cancel-edit': ui.editId = null; render(); break;
    case 'confirm': ui.confirm = el.dataset.key; render(); break;
    case 'cancel-confirm': ui.confirm = null; render(); break;
    case 'toggle-week': ui.showWeek = !ui.showWeek; render(); break;

    case 'effort': {
      const { week, item } = el.dataset; const v = +el.dataset.v;
      const cur = s.ticks[week]?.[item];
      commit({ type: 'tick', week, item, done: true, effort: cur?.effort === v ? null : v });
      break;
    }
    case 'dismiss-leftovers': commit({ type: 'tick', week: el.dataset.week, item: '__dismissed', done: true, effort: null }); break;

    case 'save-item': {
      const box = el.closest('[data-form=item]');
      const data = readItemForm(box);
      if (!data.tasks.length) { const m = box.querySelector('#f-err'); m.textContent = 'Write at least one thing to do.'; m.hidden = false; return; }
      const id = box.dataset.id;
      const day = ui.day;
      document.activeElement?.blur();
      commitPlan((p) => {
        if (id === 'new') p.days[day].items.push({ id: uid(), ...data });
        else Object.assign(p.days[day].items.find((x) => x.id === id), data);
      });
      ui.editId = null; render(); toast(id === 'new' ? 'Target added' : 'Target saved');
      break;
    }
    case 'del-item': { const id = el.dataset.id; const day = ui.day; ui.confirm = null; commitPlan((p) => { p.days[day].items = p.days[day].items.filter((x) => x.id !== id); }); toast('Target deleted'); break; }
    case 'save-class': {
      const box = el.closest('[data-form=class]');
      const time = box.querySelector('#fc-time').value.trim();
      const label = box.querySelector('#fc-label').value.trim();
      const course = box.querySelector('#fc-course').value;
      if (!/^\d{1,2}:\d{2}$/.test(time) || !label) { const m = box.querySelector('#fc-err'); m.textContent = 'Enter a time like 9:30 and a label.'; m.hidden = false; return; }
      const day = ui.day;
      document.activeElement?.blur();
      commitPlan((p) => {
        p.days[day].classes.push({ id: uid(), time, course, label });
        p.days[day].classes.sort((a, b) => (+a.time.split(':')[0] * 60 + +a.time.split(':')[1]) - (+b.time.split(':')[0] * 60 + +b.time.split(':')[1]));
      });
      ui.editId = null; render();
      break;
    }
    case 'del-class': { const id = el.dataset.id; const day = ui.day; ui.confirm = null; commitPlan((p) => { p.days[day].classes = p.days[day].classes.filter((x) => x.id !== id); }); break; }

    case 'add-deadline': {
      const box = el.closest('[data-form=deadline]');
      const title = box.querySelector('#d-title').value.trim();
      const due = box.querySelector('#d-due').value;
      const course = box.querySelector('#d-course').value;
      const err = box.querySelector('#d-err');
      if (!title || !due) { err.textContent = !title ? 'Give the deadline a name.' : 'Pick a due date.'; err.hidden = false; return; }
      document.activeElement?.blur();
      commit({ type: 'deadline', id: uid(), course, title, due, progress: 0, deleted: false });
      toast('Deadline added');
      break;
    }
    case 'progress': { const d = s.deadlines[el.dataset.id]; commit({ type: 'deadline', ...d, progress: +el.dataset.v }); break; }
    case 'del-deadline': { const d = s.deadlines[el.dataset.id]; ui.confirm = null; commit({ type: 'deadline', ...d, deleted: true }); toast('Deadline deleted'); break; }

    case 'reset-plan': ui.confirm = null; commit({ type: 'plan', plan: structuredClone(DEFAULT_PLAN) }); toast('Plan reset'); break;
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
    const cur = s.ticks[week]?.[item];
    commit({ type: 'tick', week, item, done: el.checked, effort: el.checked ? (cur?.effort ?? null) : null });
    if (el.checked && week !== 'exam') {
      const it = s.plan.days.flatMap((d) => d.items).find((x) => x.id === item);
      if (it?.hw != null) bumpDeadline(it.course, it.hw);
    }
  } else if (act === 'hours') {
    const v = el.value.trim(); const day = ui.day;
    commitPlan((p) => { p.days[day].hours = v; });
  } else if (act === 'reminder-time') {
    const [h, m] = el.value.split(':').map(Number);
    if (!Number.isFinite(h)) return;
    const q = Math.round(m / 15) * 15;
    const hh = (q === 60 ? h + 1 : h) % 24, mm = q % 60;
    const v = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    commitSettings((st) => { st.reminders[el.dataset.key] = v; });
  } else if (act === 'reminders-off') {
    commitSettings((st) => { st.reminders.off = el.checked; });
  } else if (act === 'semester-end' && el.value) {
    commitSettings((st) => { st.semesterEnd = el.value; });
  } else if (act === 'exam-date' && el.value) {
    commitSettings((st) => { st.exams.find((x) => x.id === el.dataset.id).date = el.value; });
  } else if (act === 'exam-taking') {
    commitSettings((st) => { st.exams.find((x) => x.id === el.dataset.id).taking = el.checked; });
  }
});

function route() {
  const v = location.hash.replace('#', '');
  ui.view = ['week', 'deadlines', 'stats', 'settings', 'setup'].includes(v) ? v : 'week';
  ui.confirm = null; ui.editId = null;
  if (ui.view !== 'week') ui.editing = false;
  if (ui.view === 'settings') refreshPushState().then(render);
  render();
  scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
window.addEventListener('online', () => pull());
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const { today, dow } = clock();
  if (ui.lastDate !== today) { ui.lastDate = today; ui.day = dow; }
  pull();
});
setInterval(() => {
  const { today, dow } = clock();
  if (ui.lastDate && ui.lastDate !== today) { ui.lastDate = today; ui.day = dow; render(); }
}, 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
ui.lastDate = clock().today;
route();
refreshPushState();
pull();
