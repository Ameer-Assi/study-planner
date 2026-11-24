// Study planner server: sync API on D1, plus scheduled reminders over Web Push.
import { sendPush } from './push.js';
import {
  DEFAULT_PLAN, DEFAULT_SETTINGS, DAY_NAMES, migratePlan, renameCourses, ensureWeek, nowLocal, weekOf, addDays, dowOf,
  dayParts, lateParts, openToday, unplacedGoals, planningLeft, partLabel, fullTitle,
  TASKS, openTasks, taskProgress, tasksToPlan, daysBetween, hasDue, applyPatch,
} from '../public/shared.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS ticks (week TEXT NOT NULL, item TEXT NOT NULL, done INTEGER NOT NULL, effort INTEGER, updated INTEGER NOT NULL, PRIMARY KEY (week, item))',
  'CREATE TABLE IF NOT EXISTS deadlines (id TEXT PRIMARY KEY, course TEXT NOT NULL, title TEXT NOT NULL, due TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, created INTEGER NOT NULL)',
  // The plan as it was before each change, so a bad save can be undone from Settings.
  'CREATE TABLE IF NOT EXISTS plan_history (saved INTEGER NOT NULL, json TEXT NOT NULL)',
];
const KEEP_HISTORY = 60;
// Changes within this long of the last kept version count as one round of edits, so a busy
// planning session doesn't push older versions out of the 60 kept.
const HISTORY_GAP = 10 * 60 * 1000;
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function authorized(request, env) {
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const want = env.APP_KEY || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function getKV(db, key, fallback) {
  const row = await db.prepare('SELECT value, updated FROM kv WHERE key = ?').bind(key).first();
  return row ? { value: JSON.parse(row.value), updated: row.updated } : { value: fallback, updated: 0 };
}
function putKV(db, key, value, updated) {
  return db.prepare(
    'INSERT INTO kv (key, value, updated) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated WHERE excluded.updated >= kv.updated',
  ).bind(key, JSON.stringify(value), updated);
}

async function loadCore(db) {
  const [plan, settings] = await Promise.all([getKV(db, 'plan', DEFAULT_PLAN), getKV(db, 'settings', DEFAULT_SETTINGS)]);
  // A plan saved by the old app is converted to goals once. The old one is kept as a backup.
  if (plan.updated) {
    const m = migratePlan(plan.value);
    if (m.changed) {
      const now = Date.now();
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO kv (key, value, updated) VALUES (?1, ?2, ?3)').bind('plan-v1', JSON.stringify(plan.value), now),
        putKV(db, 'plan', m.plan, now),
      ]);
      plan.value = m.plan; plan.updated = now;
    }
    // Saved with the same time, so an edit made on a phone after it still wins.
    if (renameCourses(plan.value)) await putKV(db, 'plan', plan.value, plan.updated).run();
  }
  return { plan, settings };
}

async function handleState(env, url) {
  const db = env.DB;
  const { plan, settings } = await loadCore(db);
  const weeks = Math.min(30, Math.max(1, +(url.searchParams.get('weeks') || 12)));
  const since = weekOf(addDays(nowLocal().date, -7 * (weeks - 1)));
  const [ticks, deadlines] = await Promise.all([
    db.prepare("SELECT week, item, done, effort, updated FROM ticks WHERE week >= ? OR week NOT LIKE '____-__-__'").bind(since).all(),
    db.prepare('SELECT id, course, title, due, progress, deleted, updated FROM deadlines').all(),
  ]);
  return json({
    plan: plan.value, planUpdated: plan.updated,
    settings: settings.value, settingsUpdated: settings.updated,
    ticks: ticks.results, deadlines: deadlines.results,
    vapidPublic: env.VAPID_PUBLIC || null,
  });
}
const isStr = (v, max = 2000) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The plan as it was before a change goes into the history, at most once per round of edits.
async function historyDue(db) {
  const row = await db.prepare("SELECT updated FROM kv WHERE key = 'history-at'").first();
  return !row || Date.now() - row.updated >= HISTORY_GAP;
}
function historyStmts(db, plan) {
  const now = Date.now();
  return [
    db.prepare('INSERT INTO plan_history (saved, json) VALUES (?, ?)').bind(plan.updated || now, JSON.stringify(plan.value)),
    db.prepare("INSERT INTO kv (key, value, updated) VALUES ('history-at', 'true', ?1) ON CONFLICT(key) DO UPDATE SET updated = excluded.updated").bind(now),
  ];
}

async function handleSync(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.ops) || body.ops.length > 500) return json({ error: 'Bad request' }, 400);
  const db = env.DB;
  const stmts = [];
  // Patches are applied in order to the stored plan, and it's written once. The write only
  // goes through if nobody saved the plan in between (another device syncing at the same
  // moment); otherwise it reads the plan again and reapplies the patches.
  const patches = body.ops.filter((op) => op?.type === 'plan-patch' && op.patch && typeof op.patch === 'object' && isNum(op.updated));
  let saved = !patches.length;
  for (let attempt = 0; patches.length && attempt < 10; attempt++) {
    const { plan: before } = await loadCore(db);
    // Always later than the version read, so the check below can tell two saves apart.
    let plan = before.value, updated = before.updated + 1;
    for (const op of patches) { plan = applyPatch(plan, op.patch); updated = Math.max(updated, op.updated); }
    if (JSON.stringify(plan).length >= 200000) { saved = true; break; }
    const res = await db.prepare(
      'INSERT INTO kv (key, value, updated) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated WHERE kv.updated = ?4 RETURNING updated',
    ).bind('plan', JSON.stringify(plan), updated, before.updated).first();
    if (!res) continue;
    if (await historyDue(db)) stmts.push(...historyStmts(db, before));
    saved = true;
    break;
  }
  // Still busy after every retry: nothing is applied, and the phone keeps its changes and sends them again.
  if (!saved) return json({ error: 'The plan was busy saving, try again' }, 503);
  for (const op of body.ops) {
    if (!op || !isNum(op.updated)) continue;
    if (op.type === 'tick' && isStr(op.week, 40) && isStr(op.item, 80)) {
      const effort = op.effort === -1 || op.effort === 0 || op.effort === 1 ? op.effort : null;
      // The old app sent a count for weekly goals; any count above zero means done.
      const done = isNum(op.count) ? Math.max(0, Math.min(999, Math.round(op.count))) : op.done ? 1 : 0;
      stmts.push(db.prepare(
        'INSERT INTO ticks (week, item, done, effort, updated) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(week, item) DO UPDATE SET done = excluded.done, effort = excluded.effort, updated = excluded.updated WHERE excluded.updated >= ticks.updated',
      ).bind(op.week, op.item, done, effort, op.updated));
    } else if (op.type === 'deadline' && isStr(op.id, 80) && isStr(op.course, 20) && isStr(op.title, 200) && isStr(op.due, 10)) {
      const progress = Math.max(0, Math.min(100, Math.round(+op.progress || 0)));
      stmts.push(db.prepare(
        'INSERT INTO deadlines (id, course, title, due, progress, deleted, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET course = excluded.course, title = excluded.title, due = excluded.due, progress = excluded.progress, deleted = excluded.deleted, updated = excluded.updated WHERE excluded.updated >= deadlines.updated',
      ).bind(op.id, op.course, op.title, op.due, progress, op.deleted ? 1 : 0, op.updated));
    } else if (op.type === 'plan' && op.plan && Array.isArray(op.plan.days) && op.plan.days.length === 7) {
      // A whole plan: sent by an older copy of the app, or by "Restore" in Settings.
      if (JSON.stringify(op.plan).length < 200000) {
        // Always kept, so a restore can itself be undone.
        const cur = await getKV(db, 'plan', null);
        if (cur.updated) stmts.push(...historyStmts(db, cur));
        stmts.push(putKV(db, 'plan', op.plan, op.updated));
      }
    } else if (op.type === 'settings' && op.settings && Array.isArray(op.settings.exams)) {
      if (JSON.stringify(op.settings).length < 50000) stmts.push(putKV(db, 'settings', op.settings, op.updated));
    }
  }
  if (stmts.length) {
    await db.batch(stmts);
    await db.prepare(`DELETE FROM plan_history WHERE rowid NOT IN (SELECT rowid FROM plan_history ORDER BY rowid DESC LIMIT ${KEEP_HISTORY})`).run();
  }
  return json({ ok: true, applied: stmts.length });
}

async function handleSubscribe(request, env, remove) {
  const body = await request.json().catch(() => null);
  const sub = body?.sub;
  const endpoint = remove ? body?.endpoint : sub?.endpoint;
  if (!isStr(endpoint, 1000) || !endpoint.startsWith('https://')) return json({ error: 'Bad subscription' }, 400);
  if (remove) {
    await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(endpoint).run();
  } else {
    if (!sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'Bad subscription' }, 400);
    await env.DB.prepare('INSERT OR REPLACE INTO subs (endpoint, json, created) VALUES (?, ?, ?)')
      .bind(endpoint, JSON.stringify({ endpoint, keys: sub.keys }), Date.now()).run();
  }
  return json({ ok: true });
}

async function pushAll(env, message) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { sent: 0, failed: 0, error: 'Notification keys are not set' };
  const { results } = await env.DB.prepare('SELECT endpoint, json FROM subs').all();
  let sent = 0, failed = 0;
  for (const row of results) {
    try {
      const status = await sendPush(JSON.parse(row.json), message, env);
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(row.endpoint).run();
        failed++;
      } else if (status >= 200 && status < 300) sent++;
      else failed++;
    } catch { failed++; }
  }
  return { sent, failed, devices: results.length };
}

// ---------- Reminders ----------
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function listed(items, max = 4) {
  const names = items.map(partLabel);
  return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
}

export async function buildReminder(env, when, slot) {
  const db = env.DB;
  const { plan: { value: saved } } = await loadCore(db);
  const today = when.date;
  const dow = when.dow;
  const week = weekOf(today);
  const next = addDays(week, 7);
  // Repeating goals are filled in here without saving, exactly as the phone does.
  const plan = structuredClone(saved);
  ensureWeek(plan, week); ensureWeek(plan, next);
  const tickRows = async (w) => Object.fromEntries((await db.prepare('SELECT item, done FROM ticks WHERE week = ?').bind(w).all()).results.map((r) => [r.item, { done: r.done }]));
  const [wt, tt] = await Promise.all([tickRows(week), tickRows(TASKS)]);

  // Saturday is planning day: say so while next week still has goals without a day,
  // or homework due soon that isn't in next week yet.
  const left = planningLeft(plan, null, next);
  const toPlan = dow === 6 ? tasksToPlan(plan, tt, next).length : 0;
  const planBits = [];
  if (dow === 6 && left.unplaced > 0) planBits.push(`${plural(left.unplaced, 'goal')} to place`);
  if (dow === 6 && left.goals === 0 && !toPlan) planBits.push('no goals yet');
  if (toPlan) planBits.push(`${plural(toPlan, 'deadline')} not in it`);
  const planNext = planBits.length ? `Plan next week: ${planBits.join(', ')}` : null;

  // Homework due today or tomorrow, with the questions still open.
  const dueSoon = openTasks(plan, tt).filter((t) => { if (!hasDue(t)) return false; const n = daysBetween(today, t.due); return n >= 0 && n <= 1; }).map((t) => {
    const pr = taskProgress(tt, t);
    const state = pr.left ? ` (${plural(pr.left, 'question')} left)` : pr.of ? ' (done, hand it in)' : '';
    return `${fullTitle(t)} due ${t.due === today ? 'today' : 'tomorrow'}${state}`;
  });

  if (slot === 'morning') {
    const todays = dayParts(plan, week, dow);
    const behind = lateParts(plan, wt, week, dow);
    const loose = unplacedGoals(plan, wt, week);
    const lines = [];
    if (todays.length) lines.push(listed(todays));
    lines.push(...dueSoon);
    if (behind.length) lines.push(`${behind.length} behind from earlier this week`);
    if (loose.length) lines.push(`${plural(loose.length, 'goal')} not on any day`);
    if (planNext) lines.push(planNext);
    if (!lines.length) return null;
    return { title: `${DAY_NAMES[dow]}: ${todays.length ? `${todays.length} to do` : 'nothing placed'}`, body: lines.join(' · '), tag: 'morning' };
  }

  const open = openToday(plan, wt, week, dow);
  if (!open.length && !planNext && !dueSoon.length) return null;
  if (!open.length && !dueSoon.length) return { title: 'Plan next week', body: planNext.replace('Plan next week: ', ''), tag: 'evening' };
  return { title: open.length ? `${open.length} left today` : 'Due soon', body: [open.length ? listed(open) : '', ...dueSoon, planNext].filter(Boolean).join(' · '), tag: 'evening' };
}

async function runSchedule(env, scheduledTime) {
  await ensureSchema(env.DB);
  const when = nowLocal(new Date(scheduledTime));
  const { settings: { value: settings } } = await loadCore(env.DB);
  const r = settings.reminders || DEFAULT_SETTINGS.reminders;
  if (r.off) return;
  const weekend = when.dow >= 5;
  const slot = when.hm === (weekend ? r.weekendMorning : r.morning) ? 'morning'
    : when.hm === (weekend ? r.weekendEvening : r.evening) ? 'evening' : null;
  if (!slot) return;
  const sentKey = `sent:${when.date}:${slot}`;
  const already = await env.DB.prepare('SELECT 1 FROM kv WHERE key = ?').bind(sentKey).first();
  if (already) return;
  const msg = await buildReminder(env, when, slot);
  await putKV(env.DB, sentKey, true, Date.now()).run();
  if (msg) await pushAll(env, { ...msg, url: '/' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });

    if (url.pathname === '/api/health') {
      return json({ configured: !!env.APP_KEY, push: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE), database: !!env.DB });
    }
    if (!env.APP_KEY) return json({ error: 'APP_KEY is not set on the server yet' }, 503);
    if (!authorized(request, env)) return json({ error: 'Wrong app key' }, 401);

    await ensureSchema(env.DB);
    try {
      if (url.pathname === '/api/state' && request.method === 'GET') return await handleState(env, url);
      if (url.pathname === '/api/sync' && request.method === 'POST') return await handleSync(request, env);
      if (url.pathname === '/api/subscribe' && request.method === 'POST') return await handleSubscribe(request, env, false);
      if (url.pathname === '/api/unsubscribe' && request.method === 'POST') return await handleSubscribe(request, env, true);
      if (url.pathname === '/api/history' && request.method === 'GET') {
        // Earlier versions of the plan, newest first, with a short summary of each.
        const { results } = await env.DB.prepare('SELECT rowid AS id, saved, json FROM plan_history ORDER BY rowid DESC LIMIT ?').bind(KEEP_HISTORY).all();
        const full = url.searchParams.get('id');
        if (full) { const r = results.find((x) => String(x.id) === full); return r ? json({ id: r.id, saved: r.saved, plan: JSON.parse(r.json) }) : json({ error: 'Not found' }, 404); }
        return json({ versions: results.map((r) => { const p = JSON.parse(r.json); return { id: r.id, saved: r.saved, goals: (p.goals || []).filter((g) => !g.deleted).length, tasks: (p.tasks || []).filter((t) => !t.deleted).length }; }) });
      }
      if (url.pathname === '/api/test-push' && request.method === 'POST') {
        const result = await pushAll(env, { title: 'Reminders are working', body: 'You’ll get your morning and evening reminders here.', tag: 'test', url: '/' });
        return json(result);
      }
      if (url.pathname === '/api/preview-reminder' && request.method === 'GET') {
        // ?date=2026-11-21 previews the reminder for another day.
        const date = url.searchParams.get('date');
        const when = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? { ...nowLocal(), date, dow: dowOf(date) } : nowLocal();
        const slot = url.searchParams.get('slot') === 'evening' ? 'evening' : 'morning';
        return json({ when, message: await buildReminder(env, when, slot) });
      }
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env, event.scheduledTime));
  },
};
