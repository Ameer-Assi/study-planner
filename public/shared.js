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
];

export function migratePlan(plan) {
  const p = structuredClone(plan);
  p.updates ||= [];
  let changed = false;
  for (const u of PLAN_UPDATES) {
    if (p.updates.includes(u.id)) continue;
    const all = () => p.days.flatMap((d) => d.items);
    for (const [day, item, before] of u.add) {
      if (all().some((x) => x.id === item.id)) continue;
      const items = p.days[day].items;
      const at = before ? items.findIndex((x) => x.id === before) : -1;
      if (at >= 0) items.splice(at, 0, structuredClone(item)); else items.push(structuredClone(item));
    }
    for (const [id, from, to] of u.reword) {
      const it = all().find((x) => x.id === id);
      if (it && JSON.stringify(it.tasks) === JSON.stringify(from)) it.tasks = [...to];
    }
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
export const required = (items) => items.filter((i) => !i.optional);

// Unticked required targets from earlier days of this week.
export function overdueItems(plan, weekTicks, dow) {
  const out = [];
  for (let d = 0; d < dow; d++) {
    for (const item of required(plan.days[d].items)) {
      if (!weekTicks?.[item.id]?.done) out.push({ day: d, item });
    }
  }
  return out;
}

export function remainingToday(plan, weekTicks, dow) {
  return required(plan.days[dow].items).filter((i) => !weekTicks?.[i.id]?.done);
}

// ---------- Deadlines ----------
export function deadlineStatus(dl, today) {
  if (dl.progress >= 100) return 'done';
  const left = daysBetween(today, dl.due);
  if (left < 0) return 'late';
  if (left <= 2) return 'soon';
  return 'ok';
}

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
