// Logic shared by the phone app and the server (reminders): dates, defaults, plan helpers.

export const TZ = 'Asia/Jerusalem';
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Current date/time in Israel, whatever device or server runs this.
export function nowLocal(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, dow: WD[p.weekday], hm: `${p.hour}:${p.minute}`, minutes: +p.hour * 60 + +p.minute };
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}
export function dowOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// Weeks start on Sunday. The week id is that Sunday's date.
export function weekOf(date) { return addDays(date, -dowOf(date)); }

export function fmtShortDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------- Courses ----------
export const COURSES = {
  sig: { name: 'Signals', short: 'Sig', words: ['signal', 'sig'] },
  ds: { name: 'Data structures 1', short: 'DS1', words: ['data structure', 'ds1', 'ds'] },
  prob: { name: 'Probability', short: 'Prob', words: ['probability', 'probabilty', 'prob'], topics: ['webwork'] },
  // Fundamentals of Semiconductor Devices (יסודות התקני מוליכים למחצה). The key stays 'ssd' so saved data keeps working.
  ssd: { name: 'Semiconductors', short: 'Semi', words: ['semiconductor', 'semi conductor', 'semi', 'solid state', 'solid', 'ssd'] },
  org: { name: 'Organization', short: 'Org', words: ['organization', 'organisation', 'org'], topics: ['assembly'] },
  qp: { name: 'Quantum', short: 'QP', words: ['quantum', 'qp'] },
};
// `words` are other names for the course; `topics` only help guess it ("webwork" -> Probability)
// and stay in the title, so a goal called "webwork" still reads "Probability webwork".
export const TRACKED = Object.keys(COURSES);

// Picks the course a goal's title is about ("Probability HW" -> prob), or '' for general.
export function guessCourse(title) {
  const t = ` ${String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const k of TRACKED) if ([...COURSES[k].words, ...(COURSES[k].topics || [])].some((w) => t.includes(` ${w} `) || (w.length > 4 && t.includes(w)))) return k;
  return '';
}

// ---------- Plan ----------
// The plan is goals-first (v2):
//   plan.days[d]   hours and classes for each weekday (Sunday = 0). `items` stays empty;
//                  it's only there so a phone still running the old app doesn't break.
//   plan.repeats   goals that come back every week: { id, title, course, since, usual }
//   plan.goals     one entry per goal per week: { id, title, course, week, repeatId?, taskId?, parts, deleted? }
//   plan.tasks     homework with a due date, worked on over one or more weeks (see the end of this file)
//   goal.parts     the days a goal is placed on: { id, day, note, at, start?, mins?, qs? }. Several parts = split.
//                  `qs` (homework only): the question numbers planned for that day.
//   class          { id, time, course, label, mins }
// Ticks are stored per week by id: a part's id, or the goal's id for "whole goal done".
export const PLAN_VERSION = 2;
export const V2_START = '2026-11-15'; // first week planned with goals

const cl = (id, time, course, label, mins = 60) => ({ id, time, course, label, mins });
const day = (hours, classes) => ({ hours, classes, items: [] });
const rep = (id, course, usual) => ({ id, title: `${COURSES[course].name} homework`, course, since: V2_START, usual });

// Homework for each course comes back every week. `usual` is where the old fixed plan had it.
const SEED_REPEATS = [
  rep('r-sig', 'sig', [1, 3, 4]),
  rep('r-ds', 'ds', [1, 6]),
  rep('r-prob', 'prob', [3, 5]),
  rep('r-ssd', 'ssd', [0, 2, 4]),
  rep('r-org', 'org', [2, 4]),
  rep('r-qp', 'qp', [2, 4]),
];

export const DEFAULT_PLAN = {
  v: PLAN_VERSION,
  days: [
    day('8:30–20:00', [cl('c1', '9:30', 'ds', 'DS1 lecture', 120), cl('c2', '12:30', 'ds', 'DS1 tutorial'), cl('c3', '13:30', 'qp', 'Quantum tutorial'), cl('c4', '15:30', 'org', 'Organization tutorial'), cl('c5', '16:30', 'sig', 'Signals lecture', 120)]),
    day('8:30–20:00', [cl('c6', '12:30', 'qp', 'Quantum lecture', 120), cl('c7', '14:30', 'prob', 'Probability lecture', 120), cl('c8', '16:30', 'sig', 'Signals lecture', 120)]),
    day('8:30–20:00', [cl('c9', '8:30', 'org', 'Organization lecture', 120), cl('c10', '12:30', 'ssd', 'Semiconductors lecture', 180), cl('c11', '16:30', 'ssd', 'Semiconductors tutorial')]),
    day('8:30–20:00', [cl('c12', '9:30', 'ssd', 'Semiconductors session'), cl('c13', '10:30', 'prob', 'Probability tutorial'), cl('c14', '11:30', 'qp', 'Quantum lecture'), cl('c15', '15:30', 'prob', 'Probability lecture'), cl('c16', '16:30', 'sig', 'Signals tutorial', 120)]),
    day('9:00–20:00 · no classes', []),
    day('up to 2 hours', []),
    day('up to 3 hours', []),
  ],
  repeats: SEED_REPEATS,
  goals: [],
};

// ---------- Times ----------
// Times are minutes from midnight. The timetable shows 8:30 to 20:00, and grows when
// something starts earlier or ends later.
export const DAY_START = 510;
export const DAY_END = 1200;
export const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
export const fmtMin = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
export const fmtSpan = (a, b) => `${fmtMin(a)}–${fmtMin(b)}`;

// How long a class takes. A class saved before lengths existed uses the timetable's
// length if it's still at its original time, otherwise one hour.
const SEED_MINS = Object.fromEntries(DEFAULT_PLAN.days.flatMap((d) => d.classes.map((c) => [`${c.id}@${c.time}`, c.mins])));
export const classMins = (c) => (c.mins > 0 ? c.mins : SEED_MINS[`${c.id}@${c.time}`] || 60);

// A goal's part can have a time of day: `start` (minutes from midnight) and `mins` (length).
// Both are optional. A part with no start is on its day without a time.
export const partMins = (p) => (p.mins > 0 ? p.mins : 60);
export const hasTime = (p) => Number.isFinite(p.start);

// Turns a plan saved by the old app (fixed targets on each day) into a goals-first plan.
// Hours and classes are kept. Old "repeat every week" goals keep repeating, and old
// one-off goals from the last week stay as goals. Runs the same on the phone and the server.
export function migratePlan(plan) {
  if (plan?.v === PLAN_VERSION) return { plan, changed: false };
  const p = {
    v: PLAN_VERSION,
    days: DEFAULT_PLAN.days.map((d, i) => ({
      hours: plan?.days?.[i]?.hours ?? d.hours,
      classes: structuredClone(plan?.days?.[i]?.classes ?? d.classes),
      items: [],
    })),
    repeats: structuredClone(SEED_REPEATS),
    goals: [],
  };
  for (const g of plan?.goals || []) {
    if (g.dropped || !g.title) continue;
    if (g.recurring) p.repeats.push({ id: g.id, title: g.title, course: g.course || '', since: V2_START, usual: [] });
    else if (g.week >= addDays(V2_START, -7)) p.goals.push({ id: g.id, title: g.title, course: g.course || '', week: g.week, parts: [] });
  }
  return { plan: p, changed: true };
}

// The semiconductors course was first named "Solid state". Classes and goals saved with
// that name are renamed. Safe to run any number of times, on the phone or the server.
export function renameCourses(plan) {
  let changed = false;
  const fix = (x, key) => {
    if (x?.course === 'ssd' && typeof x[key] === 'string' && /^solid state\b/i.test(x[key])) {
      x[key] = x[key].replace(/^solid state\b/i, 'Semiconductors'); changed = true;
    }
  };
  for (const d of plan?.days || []) for (const c of d.classes || []) fix(c, 'label');
  for (const r of plan?.repeats || []) fix(r, 'title');
  for (const g of plan?.goals || []) fix(g, 'title');
  return changed;
}

export const DEFAULT_SETTINGS = {
  reminders: { morning: '08:00', evening: '19:00', weekendMorning: '06:15', weekendEvening: '09:30' },
  exams: [],
};

// ---------- Saving the plan in pieces ----------
// A change to the plan is sent as a patch: the goals, homework and repeating goals that changed
// or went away (by id), and the days whose hours or classes changed. The server applies it to
// the plan it has, so two devices (or an app left open with an old copy) can't wipe out each
// other's changes the way sending the whole plan could.
const PLAN_LISTS = ['goals', 'tasks', 'repeats'];
export function diffPlan(a, b) {
  const patch = {};
  for (const k of PLAN_LISTS) {
    const before = new Map((a?.[k] || []).map((x) => [x.id, JSON.stringify(x)]));
    const after = new Set();
    const upsert = [];
    for (const x of b[k] || []) { after.add(x.id); if (before.get(x.id) !== JSON.stringify(x)) upsert.push(x); }
    const remove = [...before.keys()].filter((id) => !after.has(id));
    if (upsert.length || remove.length) patch[k] = { upsert, remove };
  }
  const days = {};
  (b.days || []).forEach((d, i) => { if (JSON.stringify(d) !== JSON.stringify(a?.days?.[i])) days[i] = d; });
  if (Object.keys(days).length) patch.days = days;
  if (b.v !== a?.v) patch.v = b.v;
  return Object.keys(patch).length ? patch : null;
}
export function applyPatch(plan, patch) {
  const p = structuredClone(plan);
  for (const k of PLAN_LISTS) {
    const ch = patch?.[k];
    if (!ch) continue;
    const gone = new Set(ch.remove || []);
    const list = (p[k] || []).filter((x) => !gone.has(x.id));
    for (const x of ch.upsert || []) {
      const i = list.findIndex((y) => y.id === x.id);
      if (i >= 0) list[i] = x; else list.push(x);
    }
    p[k] = list;
  }
  for (const [i, d] of Object.entries(patch?.days || {})) if (+i >= 0 && +i < 7) p.days[+i] = d;
  if (patch?.v) p.v = patch.v;
  return p;
}

// ---------- Goals ----------
const isDone = (wt, id) => !!wt?.[id]?.done;
export const instanceId = (repeatId, week) => `${repeatId}@${week}`;

// Makes sure every repeating goal has its entry for this week. Ids are fixed
// (repeat + week), so the phone and the server always agree without saving anything.
export function ensureWeek(plan, week) {
  let changed = false;
  for (const r of plan.repeats || []) {
    if (r.since > week) continue;
    const id = instanceId(r.id, week);
    if (plan.goals.some((g) => g.id === id)) continue;
    plan.goals.push({ id, title: r.title, course: r.course, week, repeatId: r.id, parts: [] });
    changed = true;
  }
  return changed;
}

export const weekGoals = (plan, week) => (plan.goals || []).filter((g) => g.week === week && !g.deleted);
export const repeatOf = (plan, g) => (g.repeatId ? (plan.repeats || []).find((r) => r.id === g.repeatId) || null : null);
export const sortedParts = (g) => [...g.parts].sort((a, b) => a.day - b.day);

// A goal is done when it's marked done as a whole, or every day it's placed on is ticked.
export const goalDone = (wt, g) => isDone(wt, g.id) || (g.parts.length > 0 && g.parts.every((p) => isDone(wt, p.id)));
export const partDone = (wt, g, p) => isDone(wt, p.id) || isDone(wt, g.id);

// Everything placed on one day, in the order it was put there.
export function dayParts(plan, week, d) {
  const out = [];
  for (const goal of weekGoals(plan, week)) {
    const parts = sortedParts(goal);
    parts.forEach((part, i) => { if (part.day === d) out.push({ goal, part, n: i + 1, of: parts.length }); });
  }
  return out.sort((a, b) => (a.part.at || 0) - (b.part.at || 0));
}

// Unticked parts from earlier days of the week.
export function lateParts(plan, wt, week, dow) {
  const out = [];
  for (let d = 0; d < dow; d++) for (const x of dayParts(plan, week, d)) if (!partDone(wt, x.goal, x.part)) out.push(x);
  return out;
}
export const openToday = (plan, wt, week, dow) => dayParts(plan, week, dow).filter((x) => !partDone(wt, x.goal, x.part));

// Goals that aren't on any day yet.
export const unplacedGoals = (plan, wt, week) => weekGoals(plan, week).filter((g) => !g.parts.length && !goalDone(wt, g));
export const unfinishedGoals = (plan, wt, week) => weekGoals(plan, week).filter((g) => !goalDone(wt, g));

// A week still needs planning when it has no goals at all, or goals not placed on a day.
export function planningLeft(plan, wt, week) {
  const goals = weekGoals(plan, week);
  return { goals: goals.length, unplaced: unplacedGoals(plan, wt, week).length };
}

// The days a repeating goal usually goes on: where it was last week, else its starting days.
export function usualDays(plan, g) {
  const r = repeatOf(plan, g);
  if (!r) return [];
  const prev = plan.goals.find((x) => x.id === instanceId(r.id, addDays(g.week, -7)) && !x.deleted);
  const days = prev?.parts.length ? prev.parts.map((p) => p.day) : r.usual || [];
  return [...new Set(days)].sort((a, b) => a - b);
}

// Where a repeating goal usually goes, with last week's times when it had them.
export function usualSlots(plan, g) {
  const r = repeatOf(plan, g);
  if (!r) return [];
  const prev = plan.goals.find((x) => x.id === instanceId(r.id, addDays(g.week, -7)) && !x.deleted);
  const seen = new Set();
  const slots = prev?.parts.length
    ? sortedParts(prev).map((p) => ({ day: p.day, ...(hasTime(p) ? { start: p.start, mins: partMins(p) } : {}) }))
    : (r.usual || []).map((day) => ({ day }));
  return slots.filter((x) => !seen.has(x.day) && seen.add(x.day)).sort((a, b) => a.day - b.day);
}

// Copies one week's plan into another: every goal on the same days, at the same times and
// lengths, with the same notes. Nothing comes across ticked, since the parts get new ids.
// Repeating goals fill their entry in the target week. Other goals get a copy, which a later
// copy updates instead of duplicating. Goals only in the target week are left alone.
// Returns the target goals that were filled in.
// A homework goal only comes across while `keepTask(task)` says it's still open and due
// in or after the target week.
export function copyWeek(plan, from, to, newId, keepTask = () => true) {
  const out = [];
  for (const g of weekGoals(plan, from)) {
    const task = g.taskId ? findTask(plan, g.taskId) : null;
    if (g.taskId && (!task || dueBy(task) < to || !keepTask(task))) continue;
    const parts = sortedParts(g).map((p) => ({ id: newId(), day: p.day, note: p.note || '', at: p.at, ...(hasTime(p) ? { start: p.start, mins: partMins(p) } : {}) }));
    const r = repeatOf(plan, g);
    let t;
    if (task) {
      const id = taskGoalId(task.id, to);
      t = plan.goals.find((x) => x.id === id);
      if (!t) { t = { id, title: task.title, course: task.course, week: to, taskId: task.id, parts: [] }; plan.goals.push(t); }
    } else if (r && r.since <= to) {
      const id = instanceId(r.id, to);
      t = plan.goals.find((x) => x.id === id);
      if (!t) { t = { id, title: r.title, course: r.course, week: to, repeatId: r.id, parts: [] }; plan.goals.push(t); }
    } else {
      t = plan.goals.find((x) => x.week === to && x.copiedFrom === g.id);
      if (!t) { t = { id: newId(), title: g.title, course: g.course, week: to, parts: [], copiedFrom: g.id }; plan.goals.push(t); }
      t.title = g.title; t.course = g.course;
    }
    delete t.deleted;
    t.parts = parts;
    out.push(t.id);
  }
  return out;
}

// Goals older than this many weeks are dropped from the saved plan.
export const KEEP_WEEKS = 6;
// Homework with no due date is kept while it's open; once handed in, until its last week is old.
// `tt` is the TASKS ticks; without it, homework with no due date is always kept.
export function pruneGoals(plan, week, tt) {
  const oldest = addDays(week, -7 * KEEP_WEEKS);
  plan.goals = plan.goals.filter((g) => g.week >= oldest);
  if (plan.tasks) plan.tasks = plan.tasks.filter((t) => (hasDue(t) ? t.due >= oldest : !tt || !taskDone(tt, t) || lastWorked(plan, t) >= oldest));
}

// Questions given to one day of a homework, as "Q1–2, Q5".
export function qsLabel(qs) {
  const n = [...new Set(qs || [])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `Q${n[i]}–${n[j]}` : `Q${n[i]}`);
    i = j;
  }
  return out.join(', ');
}
// What a part is about: its questions and its note.
export const partNote = (p) => [qsLabel(p.qs), p.note].filter(Boolean).join(' · ');
export const partLabel = (x) => (partNote(x.part) ? `${fullTitle(x.goal)} (${partNote(x.part)})` : fullTitle(x.goal));

// ---------- Titles ----------
// A title can leave out its course ("HW3") since the course is picked separately.
// The week grid shows the course code above the title, so it uses bareTitle ("Quantum HW2" -> "HW2").
// Lists, reminders and toasts use fullTitle, which puts the course in front when the title doesn't
// already say it ("HW3" -> "Quantum HW3"; "Quantum HW2" stays as it is).
const reEsc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function stripCourse(x) {
  const c = COURSES[x.course];
  let t = ` ${x.title || ''} `;
  for (const w of [c.name, ...c.words].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`(^|[^a-z0-9])${reEsc(w)}(?=[^a-z0-9]|$)`, 'i'), '$1');
  return squash(t);
}
export const bareTitle = (x) => (COURSES[x.course] ? stripCourse(x) || x.title : x.title);
export function fullTitle(x) {
  const c = COURSES[x.course];
  const t = squash(x.title);
  if (!c) return x.title;
  if (!t) return c.name;
  return stripCourse(x) === t ? `${c.name} ${t}` : x.title;
}

// ---------- Homework with a due date ----------
//   plan.tasks   { id, title, course, due: 'YYYY-MM-DD' or '' for no due date, questions: n (0 = no checklist), created, dueWas? }
// Homework with no due date (some courses don't set one) keeps the checklist and weeks, but
// gets no due-date warnings or reminders. For "is it still due by week X" it counts as never due.
// A task isn't tied to a week. Each week it's worked on, it gets a goal in that week with
// `taskId` set and a fixed id (task + week), placed on days like any goal. Ticking those days
// only means "worked on it". The task itself, and each question, is ticked under the week
// key TASKS: item = task id for "handed in", `${id}.q3` for question 3.
export const TASKS = 'tasks';
export const taskGoalId = (taskId, week) => `${taskId}@${week}`;
export const qKey = (t, i) => `${t.id}.q${i}`;
export const allTasks = (plan) => (plan.tasks || []).filter((t) => !t.deleted);
export const findTask = (plan, id) => (id ? allTasks(plan).find((t) => t.id === id) || null : null);
export const taskDone = (tt, t) => !!tt?.[t.id]?.done;
export const taskGoals = (plan, t) => (plan.goals || []).filter((g) => g.taskId === t.id && !g.deleted);
export const MAX_QUESTIONS = 20;
export const hasDue = (t) => /^\d{4}-\d{2}-\d{2}$/.test(t?.due || '');
export const dueBy = (t) => (hasDue(t) ? t.due : '9999-12-31');
// The last day of the last week it was in, or the day it was added.
export function lastWorked(plan, t) {
  let d = t.created || '';
  for (const g of taskGoals(plan, t)) { const e = addDays(g.week, 6); if (e > d) d = e; }
  return d;
}
// When it's over: its due date, or with none, its last week.
export const taskEnd = (plan, t) => (hasDue(t) ? t.due : lastWorked(plan, t));

export function taskProgress(tt, t) {
  const of = Math.max(0, Math.min(MAX_QUESTIONS, t.questions || 0));
  let done = 0;
  for (let i = 1; i <= of; i++) if (tt?.[qKey(t, i)]?.done) done++;
  return { done, of, left: of - done };
}

// Open tasks by due date, soonest first; those with no due date last.
export const openTasks = (plan, tt) => allTasks(plan).filter((t) => !taskDone(tt, t)).sort((a, b) => (dueBy(a) < dueBy(b) ? -1 : dueBy(a) > dueBy(b) ? 1 : 0));

// "due today", "due tomorrow", "due Thu", "due 3 Dec", "2 days late".
export function dueLabel(due, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due || '')) return 'no due date';
  const n = daysBetween(today, due);
  if (n < 0) return n === -1 ? '1 day late' : `${-n} days late`;
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n <= 6) return `due ${DAY_NAMES[dowOf(due)].slice(0, 3)}`;
  return `due ${fmtShortDate(due)}`;
}

// Open tasks due by `until` (inclusive) that have no goal in `week` yet: the ones to plan in.
export function tasksToPlan(plan, tt, week, until = addDays(week, 9)) {
  return openTasks(plan, tt).filter((t) => hasDue(t) && t.due >= week && t.due <= until && !plan.goals.some((g) => g.id === taskGoalId(t.id, week) && !g.deleted));
}

// Everything worth warning about for one task. `ticks` is every week's ticks, by week.
export function taskWarnings(plan, ticks, t, today) {
  const tt = ticks?.[TASKS] || {};
  if (taskDone(tt, t) || !hasDue(t)) return [];
  const out = [];
  const days = daysBetween(today, t.due);
  const parts = [];
  for (const g of taskGoals(plan, t)) for (const p of g.parts) parts.push({ date: addDays(g.week, p.day), done: partDone(ticks?.[g.week], g, p) });
  if (days < 0) out.push({ k: 'late', text: 'past its due date' });
  else {
    if (parts.some((x) => x.date > t.due && !x.done)) out.push({ k: 'after', text: 'a day is after the due date' });
    // Every day it was put on is ticked: that reads as finished, not as "nothing planned".
    const allTicked = parts.length > 0 && parts.every((x) => x.done);
    if (days <= 6 && !allTicked && !parts.some((x) => !x.done && x.date >= today && x.date <= t.due)) out.push({ k: 'none', text: 'no day planned before it’s due' });
  }
  const pr = taskProgress(tt, t);
  if (pr.left > 0 && days >= 0 && (days <= 1 || (days <= 3 && pr.left * 2 > pr.of))) out.push({ k: 'behind', text: `${pr.left} of ${pr.of} questions left` });
  return out;
}
