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

// ---------- Default plan ----------
export const COURSES = {
  sig: { name: 'Signals', short: 'Sig', track: true },
  ds: { name: 'Data structures 1', short: 'DS1', track: true },
  prob: { name: 'Probability', short: 'Prob', track: true },
  ssd: { name: 'Solid state', short: 'SSD', track: true },
  org: { name: 'Organization', short: 'Org', track: true },
  qp: { name: 'Quantum', short: 'QP', track: true },
  flex: { name: 'Catch-up', short: 'Flex', track: false },
  any: { name: 'Get ahead', short: 'Extra', track: false },
};
export const TRACKED = Object.keys(COURSES).filter((k) => COURSES[k].track);

const REC = 'Watch the tutorial live, or the recording at 1.5x in the same slot';
let n = 0;
const it = (course, when, tasks, extra = {}) => ({ id: `t${++n}`, course, when, tasks, optional: false, hw: null, ...extra });
const cl = (time, course, label) => ({ id: `c${++n}`, time, course, label });

const BASE_PLAN = {
  days: [
    { hours: '8:30–20:00',
      classes: [cl('9:30', 'ds', 'DS1 lecture'), cl('12:30', 'ds', 'DS1 tutorial'), cl('13:30', 'qp', 'Quantum tutorial'), cl('15:30', 'org', 'Organization tutorial'), cl('16:30', 'sig', 'Signals lecture')],
      items: [
        it('any', '6:30', ['Read the DS1 slides before the 9:30 lecture'], { optional: true }),
        it('qp', 'before 9:30', ['Review Monday and Wednesday lectures: key equations and what they mean physically']),
        it('ds', '12:30 slot', [REC]),
        it('ds', '14:30 gap', ['Write each new structure’s invariants, operations and complexities', 'Re-solve the tutorial examples']),
        it('org', '15:30 slot', [REC]),
        it('ssd', 'evening', ['Reread Tuesday and Wednesday notes', 'Update the formula sheet']),
      ] },
    { hours: '8:30–20:00',
      classes: [cl('12:30', 'qp', 'Quantum lecture'), cl('14:30', 'prob', 'Probability lecture'), cl('16:30', 'sig', 'Signals lecture')],
      items: [
        it('any', '6:30', ['Push the Signals homework toward 50%'], { optional: true }),
        it('sig', 'morning', ['Review Sunday’s lecture and update your transform table', 'Homework to 30%'], { hw: 30 }),
        it('ds', 'morning', ['Homework to 50% (not submitted, still do it)'], { hw: 50 }),
        it('prob', 'evening', ['Review today’s lecture', 'Add new formulas to the formula sheet']),
      ] },
    { hours: '8:30–20:00',
      classes: [cl('8:30', 'org', 'Organization lecture'), cl('12:30', 'ssd', 'Solid state lecture'), cl('16:30', 'ssd', 'Solid state tutorial')],
      items: [
        it('any', '6:30', ['Review Monday’s Quantum lecture'], { optional: true }),
        it('org', 'evening', ['Review this morning’s lecture', 'Write and run a small assembly program on the new topic', 'Homework to 40%'], { hw: 40 }),
      ] },
    { hours: '8:30–20:00',
      classes: [cl('9:30', 'ssd', 'Solid state session'), cl('10:30', 'prob', 'Probability tutorial'), cl('11:30', 'qp', 'Quantum lecture'), cl('15:30', 'prob', 'Probability lecture'), cl('16:30', 'sig', 'Signals tutorial')],
      items: [
        it('any', '6:30', ['Practice convolution until it’s automatic'], { optional: true }),
        it('sig', 'before 9:30', ['Homework to 60%, before today’s tutorial'], { hw: 60 }),
        it('prob', '10:30 slot', [REC]),
        it('prob', '12:30–15:30 gap', ['Re-solve the tutorial examples', 'Homework to 40%'], { hw: 40 }),
        it('sig', 'evening', ['Go over today’s tutorial and list what’s left in the homework']),
      ] },
    { hours: '8:30–20:00 · no classes',
      classes: [],
      items: [
        it('any', '6:30', ['Clear your list of unsolved problems, or later in the semester start a past exam'], { optional: true }),
        it('org', 'morning', ['Homework to 100%', 'Trace assembly code by hand: registers, stack, calls'], { hw: 100 }),
        it('ssd', 'late morning', ['Review Tuesday’s lecture and Wednesday’s session', 'Solve the tutorial problems', 'Homework to 50%'], { hw: 50 }),
        it('qp', 'early afternoon', ['Solve the tutorial problems', 'Homework to 60%'], { hw: 60 }),
        it('sig', 'afternoon', ['Homework to 100%'], { hw: 100 }),
        it('flex', 'late afternoon', ['Catch up on anything behind this week', 'Go through your list of unsolved problems', 'DS1 midterm week: all DS1']),
      ] },
    { hours: '6:15–10:00',
      classes: [],
      items: [
        it('prob', 'first', ['Homework to 100%', 'Update the formula sheet'], { hw: 100 }),
        it('ds', 'second', ['Homework to 100%', 'From mid-semester: a past exam instead'], { hw: 100 }),
      ] },
    { hours: '6:15–10:00',
      classes: [],
      items: [
        it('qp', 'first', ['Homework to 100%', 'Quick review of the week’s lectures'], { hw: 100 }),
        it('ssd', 'second', ['Homework to 100%', 'Anything behind from the week goes here first'], { hw: 100 }),
      ] },
  ],
};

// ---------- Plan updates ----------
// Each update runs once on a saved plan. Items get fixed ids so ticks stay attached.
// Existing targets are only reworded if their text is still the original.
const review = (id, course) => ({
  id, course, when: 'evening', optional: false, hw: null,
  tasks: ['Review today’s lecture: key definitions and formulas in your own words', 'Write down anything you didn’t understand'],
});
const hw = (id, course, when, pct, tasks, extra = {}) => ({ id, course, when, tasks, optional: false, hw: pct, ...extra });
const PLAN_UPDATES = [
  {
    id: 'lecture-review',
    add: [
      // [day, item, insert before this id (or null to append)]
      [0, review('rev-sun-sig', 'sig'), 't11'],
      [1, review('rev-mon-qp', 'qp'), 't18'],
      [1, review('rev-mon-sig', 'sig'), null],
      [2, review('rev-tue-ssd', 'ssd'), null],
      [3, review('rev-wed-qp', 'qp'), 't33'],
      [3, review('rev-wed-prob', 'prob'), 't33'],
    ],
    reword: [
      ['t7', ['Review Monday and Wednesday lectures: key equations and what they mean physically'], ['Reread your Quantum notes from Monday and Wednesday before today’s tutorial']],
      ['t16', ['Review Sunday’s lecture and update your transform table', 'Homework to 30%'], ['Update your transform table', 'Homework to 30%']],
      ['t22', ['Review Monday’s Quantum lecture'], ['Get ahead on the Organization homework']],
      ['t36', ['Review Tuesday’s lecture and Wednesday’s session', 'Solve the tutorial problems', 'Homework to 50%'], ['Go over Wednesday’s session', 'Solve the tutorial problems', 'Homework to 50%']],
    ],
  },
  {
    // Homework ladders rebuilt around each course's real rules (Nov 2026):
    // Solid state, Signals and the Quantum dry sheet are due Thursday; Fri and Sat are short days.
    id: 'homework-rules-2026-11',
    since: '2026-11-15',
    remove: ['t6', 't15', 't22', 't29', 't34', 't43'],
    hours: [
      // [day, values it may still have, new value]
      [4, ['8:30–20:00 · no classes'], '9:00–20:00 · no classes'],
      [5, ['6:15–10:00'], 'up to 2 hours'],
      [6, ['6:15–10:00'], 'up to 3 hours'],
    ],
    put: [
      // [day, item, insert before this id]. No third value: an existing item keeps its place.
      [0, hw('t11', 'ssd', 'evening', 25, ['Reread Tuesday and Wednesday notes', 'Prep exercise as a warm-up, then homework to 25%', 'Update the formula sheet'])],
      [1, hw('hw-mon-ww', 'prob', 'evening', 50, ['WeBWorK to 50%, when a sheet is open'], { optional: true, match: 'webwork' }), 'rev-mon-sig'],
      [2, hw('hw-tue-qpm', 'qp', '10:30 gap', 100, ['Moodle exercise to 100%, when one is open (due Wednesday)'], { optional: true, match: 'moodle' }), 't23'],
      [2, hw('hw-tue-qp', 'qp', '10:30 gap', 70, ['Dry sheet to 70%'], { match: 'dry' }), 't23'],
      [2, hw('hw-tue-ssd', 'ssd', '14:30 gap', 50, ['Homework to 50%, before the tutorial']), 't23'],
      [3, hw('t32', 'prob', '12:30–15:30 gap', 40, ['Re-solve the tutorial examples', 'Written sheet to 40%: sheets 2, 5, 7, 9 and 11 in full, the others selected questions'], { match: 'written' })],
      [4, hw('t36', 'ssd', 'morning', 100, ['Go over Wednesday’s session', 'Homework to 100% and submit (due Thursday)']), 't35'],
      [4, hw('t38', 'sig', 'late morning', 100, ['Homework to 100% and submit with your partner (due Thursday)']), 't35'],
      [4, hw('t37', 'qp', 'early afternoon', 100, ['Solve the tutorial problems', 'Dry sheet to 100% and submit (due Thursday)'], { match: 'dry' }), 't35'],
      [4, hw('t35', 'org', 'afternoon', 100, ['Homework to 100%', 'Trace assembly code by hand: registers, stack, calls'])],
      [5, hw('t40', 'prob', 'first', 100, ['Written sheet to 100%, and submit if it’s sheet 2, 5, 7, 9 or 11', 'Update the formula sheet'], { match: 'written' })],
      [5, hw('hw-fri-ww', 'prob', 'second', 100, ['WeBWorK to 100%, when a sheet is open (due Sunday)'], { optional: true, match: 'webwork' }), null],
      [6, hw('t42', 'qp', 'first', 40, ['Start the new dry sheet: to 40%', 'Quick review of the week’s lectures'], { match: 'dry' })],
      [6, hw('hw-sat-qpp', 'qp', 'second', 100, ['Prep assignment to 100%, when one is open (due Sunday)'], { optional: true, match: 'prep' }), null],
      [6, hw('t41', 'ds', 'last', 100, ['Homework to 100% (not submitted, so drop this first on a short day)', 'From mid-semester: a past exam instead']), null],
    ],
  },
];

// Insert or replace an item by id. Replacing keeps its ticks, since ticks are stored by id.
function putItem(p, day, item, before, since) {
  let found = null;
  p.days.forEach((d, di) => d.items.forEach((x, xi) => { if (x.id === item.id) found = { di, xi }; }));
  const next = structuredClone(item);
  if (found && found.di === day && before === undefined) { p.days[day].items[found.xi] = next; return; }
  if (found) p.days[found.di].items.splice(found.xi, 1);
  else if (since && !next.optional) next.since = since; // new targets don't count against earlier weeks
  const items = p.days[day].items;
  const at = before ? items.findIndex((x) => x.id === before) : -1;
  if (at >= 0) items.splice(at, 0, next); else items.push(next);
}

export function migratePlan(plan) {
  const p = structuredClone(plan);
  p.updates ||= [];
  let changed = false;
  for (const u of PLAN_UPDATES) {
    if (p.updates.includes(u.id)) continue;
    const all = () => p.days.flatMap((d) => d.items);
    for (const [day, item, before] of u.add || []) {
      if (all().some((x) => x.id === item.id)) continue;
      const items = p.days[day].items;
      const at = before ? items.findIndex((x) => x.id === before) : -1;
      if (at >= 0) items.splice(at, 0, structuredClone(item)); else items.push(structuredClone(item));
    }
    for (const [id, from, to] of u.reword || []) {
      const it = all().find((x) => x.id === id);
      if (it && JSON.stringify(it.tasks) === JSON.stringify(from)) it.tasks = [...to];
    }
    for (const d of p.days) d.items = d.items.filter((x) => !(u.remove || []).includes(x.id));
    for (const [day, from, to] of u.hours || []) if (from.includes(p.days[day].hours)) p.days[day].hours = to;
    for (const [day, item, before] of u.put || []) putItem(p, day, item, before, u.since);
    p.updates.push(u.id);
    changed = true;
  }
  return { plan: p, changed };
}

export const DEFAULT_PLAN = migratePlan(BASE_PLAN).plan;

export const DEFAULT_SETTINGS = {
  reminders: { morning: '08:00', evening: '19:00', weekendMorning: '06:15', weekendEvening: '09:30' },
  semesterEnd: '2027-01-22',
  exams: [
    { id: 'qpA', course: 'qp', moed: 'A', date: '2027-02-01', taking: true },
    { id: 'dsA', course: 'ds', moed: 'A', date: '2027-02-07', taking: true },
    { id: 'ssdA', course: 'ssd', moed: 'A', date: '2027-02-10', taking: true },
    { id: 'probA', course: 'prob', moed: 'A', date: '2027-02-15', taking: true },
    { id: 'sigA', course: 'sig', moed: 'A', date: '2027-02-21', taking: true },
    { id: 'orgA', course: 'org', moed: 'A', date: '2027-02-25', taking: true },
    { id: 'qpB', course: 'qp', moed: 'B', date: '2027-03-03', taking: false },
    { id: 'ssdB', course: 'ssd', moed: 'B', date: '2027-03-07', taking: false },
    { id: 'dsB', course: 'ds', moed: 'B', date: '2027-03-14', taking: false },
    { id: 'probB', course: 'prob', moed: 'B', date: '2027-03-16', taking: false },
    { id: 'sigB', course: 'sig', moed: 'B', date: '2027-03-18', taking: false },
    { id: 'orgB', course: 'org', moed: 'B', date: '2027-03-21', taking: false },
  ],
};

// ---------- Plan helpers ----------
// Required targets. Given a week, targets added later than that week don't count for it.
export const required = (items, week) => items.filter((i) => !i.optional && (!week || !i.since || i.since <= week));

// Unticked required targets from earlier days of this week.
export function overdueItems(plan, weekTicks, dow, week) {
  const out = [];
  for (let d = 0; d < dow; d++) {
    for (const item of required(plan.days[d].items, week)) {
      if (!weekTicks?.[item.id]?.done) out.push({ day: d, item });
    }
  }
  return out;
}

export function remainingToday(plan, weekTicks, dow, week) {
  return required(plan.days[dow].items, week).filter((i) => !weekTicks?.[i.id]?.done);
}

// ---------- Deadlines ----------
export function deadlineStatus(dl, today) {
  if (dl.progress >= 100) return 'done';
  const left = daysBetween(today, dl.due);
  if (left < 0) return 'late';
  if (left <= 2) return 'soon';
  return 'ok';
}

// The deadline a ticked "Homework to N%" target moves. Courses with several kinds of
// homework tag their targets with `match` (a word in the deadline's name, like "moodle"),
// and only a deadline due within nine days counts, so a sheet two weeks away isn't touched.
export function deadlineFor(deadlines, item, today) {
  const open = deadlines
    .filter((d) => !d.deleted && d.course === item.course && d.progress < 100 && daysBetween(today, d.due) >= -7)
    .filter((d) => !item.match || (d.title.toLowerCase().includes(item.match) && daysBetween(today, d.due) <= 9))
    .sort((a, b) => a.due.localeCompare(b.due));
  return open[0] || null;
}

// Due dates published by the courses. Each set is added once; deleting one in the app sticks.
const dl = (id, course, title, due) => ({ id, course, title, due });
export const DEADLINE_SEEDS = [
  {
    id: 'hw-2026-11',
    items: [
      dl('s-qp-m3', 'qp', 'Moodle 3: photoelectric effect', '2026-11-18'),
      dl('s-qp-m4', 'qp', 'Moodle 4: de Broglie and Bragg', '2026-11-25'),
      dl('s-qp-m5', 'qp', 'Moodle 5: Bohr model', '2026-12-02'),
      dl('s-qp-p1', 'qp', 'Prep 1: Dirac notation', '2026-11-29'),
      dl('s-qp-p2', 'qp', 'Prep 2: infinite well', '2026-12-20'),
      dl('s-qp-p3', 'qp', 'Prep 3: harmonic oscillator', '2027-01-03'),
      dl('s-qp-p4', 'qp', 'Prep 4: angular momentum', '2027-01-10'),
      dl('s-qp-p5', 'qp', 'Prep 5: spin', '2027-01-17'),
      dl('s-prob-ww1', 'prob', 'WeBWorK 1', '2026-11-22'),
      dl('s-prob-ww2', 'prob', 'WeBWorK 2', '2026-11-29'),
      dl('s-prob-ww3', 'prob', 'WeBWorK 3', '2026-12-06'),
      dl('s-prob-w2', 'prob', 'Written HW 2', '2026-11-30'),
      dl('s-prob-w5', 'prob', 'Written HW 5', '2026-12-16'),
      dl('s-prob-w7', 'prob', 'Written HW 7', '2026-12-30'),
      dl('s-prob-w9', 'prob', 'Written HW 9', '2027-01-14'),
      dl('s-prob-w11', 'prob', 'Written HW 11', '2027-01-28'),
      dl('s-org-hw1', 'org', 'HW1 wet: basic assembly', '2026-11-24'),
    ],
  },
];

// ---------- Exams ----------
export function takingExams(settings) {
  return settings.exams.filter((e) => e.taking).sort((a, b) => a.date.localeCompare(b.date));
}
export function upcomingExams(settings, today) {
  return takingExams(settings).filter((e) => e.date >= today);
}
export function inExamMode(settings, today) {
  return today > settings.semesterEnd && upcomingExams(settings, today).length > 0;
}

// Prep plan for the next exam, built from the gap since the previous exam (or end of semester).
export function examPrep(settings, today) {
  const list = takingExams(settings);
  const next = list.find((e) => e.date >= today);
  if (!next) return null;
  const prev = [...list].reverse().find((e) => e.date < next.date);
  const start = addDays(prev && prev.date >= settings.semesterEnd ? prev.date : settings.semesterEnd, 1);
  const end = addDays(next.date, -1);
  const total = Math.max(1, daysBetween(start, end) + 1);
  const index = Math.min(total - 1, Math.max(0, daysBetween(start, today)));
  const daysLeft = daysBetween(today, next.date);
  let phase, tasks;
  if (daysLeft === 0) {
    phase = 'Exam day';
    tasks = ['Light look at the formula sheet only', 'Eat, arrive early, good luck'];
  } else if (daysLeft === 1 || index >= total - 1) {
    phase = 'Final day';
    tasks = ['One full past exam in real exam conditions', 'Review every mistake and the formula sheet', 'Stop early and sleep well'];
  } else if (index < Math.ceil(total * 0.4)) {
    phase = 'Review';
    tasks = ['Go topic by topic through your summary', 'Redo the key tutorial and homework problems', 'Build or finish the formula sheet'];
  } else {
    phase = 'Past exams';
    tasks = ['Solve one past exam, timed', 'Check it and redo every mistake', 'Add what you missed to the formula sheet'];
  }
  return { exam: next, daysLeft, phase, tasks, start, total, index };
}

// ---------- Weekly goals ----------
// Goals live in plan.goals. Recurring goals show every week from startWeek on;
// one-off goals belong to a single week. Progress is a count stored in ticks.
export const GOAL_SOFT_CAP = 5;
export const GOAL_FLAG_DOW = 4; // unfinished goals are flagged from Thursday

export function activeGoals(plan, week) {
  return (plan.goals || []).filter((g) => !g.dropped && (g.recurring ? (g.startWeek || '') <= week : g.week === week));
}
export const goalCount = (weekTicks, g) => Math.max(0, +(weekTicks?.[g.id]?.done || 0));
export const goalDone = (weekTicks, g) => goalCount(weekTicks, g) >= (g.target || 1);
export const openGoals = (plan, weekTicks, week) => activeGoals(plan, week).filter((g) => !goalDone(weekTicks, g));
