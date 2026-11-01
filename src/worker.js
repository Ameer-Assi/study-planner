// Study planner server: sync API on D1, plus scheduled reminders over Web Push.
import { sendPush } from './push.js';
import {
  DEFAULT_PLAN, DEFAULT_SETTINGS, COURSES, migratePlan, DAY_NAMES, nowLocal, weekOf, daysBetween,
  overdueItems, remainingToday, required, deadlineStatus, inExamMode, examPrep,
} from '../public/shared.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS ticks (week TEXT NOT NULL, item TEXT NOT NULL, done INTEGER NOT NULL, effort INTEGER, updated INTEGER NOT NULL, PRIMARY KEY (week, item))',
  'CREATE TABLE IF NOT EXISTS deadlines (id TEXT PRIMARY KEY, course TEXT NOT NULL, title TEXT NOT NULL, due TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, created INTEGER NOT NULL)',
];
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
  // Saved plans pick up new plan updates once, keeping the user's own edits.
  if (plan.updated) {
    const m = migratePlan(plan.value);
    if (m.changed) {
      const now = Date.now();
      await putKV(db, 'plan', m.plan, now).run();
      plan.value = m.plan; plan.updated = now;
    }
  }
  return { plan, settings };
}

async function handleState(env, url) {
  const db = env.DB;
  const { plan, settings } = await loadCore(db);
  const weeks = Math.min(30, Math.max(1, +(url.searchParams.get('weeks') || 12)));
  const since = weekOf(addDaysSafe(nowLocal().date, -7 * (weeks - 1)));
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
function addDaysSafe(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const isStr = (v, max = 2000) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function handleSync(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.ops) || body.ops.length > 500) return json({ error: 'Bad request' }, 400);
  const db = env.DB;
  const stmts = [];
  for (const op of body.ops) {
    if (!op || !isNum(op.updated)) continue;
    if (op.type === 'tick' && isStr(op.week, 40) && isStr(op.item, 80)) {
      const effort = op.effort === -1 || op.effort === 0 || op.effort === 1 ? op.effort : null;
      stmts.push(db.prepare(
        'INSERT INTO ticks (week, item, done, effort, updated) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(week, item) DO UPDATE SET done = excluded.done, effort = excluded.effort, updated = excluded.updated WHERE excluded.updated >= ticks.updated',
      ).bind(op.week, op.item, op.done ? 1 : 0, effort, op.updated));
    } else if (op.type === 'deadline' && isStr(op.id, 80) && isStr(op.course, 20) && isStr(op.title, 200) && isStr(op.due, 10)) {
      const progress = Math.max(0, Math.min(100, Math.round(+op.progress || 0)));
      stmts.push(db.prepare(
        'INSERT INTO deadlines (id, course, title, due, progress, deleted, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET course = excluded.course, title = excluded.title, due = excluded.due, progress = excluded.progress, deleted = excluded.deleted, updated = excluded.updated WHERE excluded.updated >= deadlines.updated',
      ).bind(op.id, op.course, op.title, op.due, progress, op.deleted ? 1 : 0, op.updated));
    } else if (op.type === 'plan' && op.plan && Array.isArray(op.plan.days) && op.plan.days.length === 7) {
      if (JSON.stringify(op.plan).length < 200000) stmts.push(putKV(db, 'plan', op.plan, op.updated));
    } else if (op.type === 'settings' && op.settings && Array.isArray(op.settings.exams)) {
      if (JSON.stringify(op.settings).length < 50000) stmts.push(putKV(db, 'settings', op.settings, op.updated));
    }
  }
  if (stmts.length) await db.batch(stmts);
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
const names = (items) => [...new Set(items.map((i) => COURSES[i.course]?.name || i.course))].join(', ');

export async function buildReminder(env, when, slot) {
  const db = env.DB;
  const { plan: { value: plan }, settings: { value: settings } } = await loadCore(db);
  const today = when.date;
  const dow = when.dow;
  const week = weekOf(today);
  const { results } = await db.prepare('SELECT item, done FROM ticks WHERE week = ?').bind(week).all();
  const wt = Object.fromEntries(results.map((r) => [r.item, { done: !!r.done }]));
  const dls = (await db.prepare('SELECT course, title, due, progress FROM deadlines WHERE deleted = 0').all()).results;
  const urgent = dls.filter((d) => ['soon', 'late'].includes(deadlineStatus(d, today)));

  if (inExamMode(settings, today)) {
    if (slot !== 'morning') return null;
    const p = examPrep(settings, today);
    const course = COURSES[p.exam.course]?.name || p.exam.course;
    const title = p.daysLeft === 0 ? `${course} exam today` : `${course} exam in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`;
    return { title, body: `${p.phase}: ${p.tasks[0]}`, tag: 'morning' };
  }

  if (slot === 'morning') {
    const todays = required(plan.days[dow].items);
    const behind = overdueItems(plan, wt, dow);
    const lines = [];
    if (todays.length) lines.push(names(todays));
    if (behind.length) lines.push(`${behind.length} behind from earlier this week`);
    for (const d of urgent.slice(0, 2)) {
      const left = daysBetween(today, d.due);
      lines.push(`${d.title}: ${left < 0 ? 'overdue' : left === 0 ? 'due today' : left === 1 ? 'due tomorrow' : `due in ${left} days`}, at ${d.progress}%`);
    }
    if (!todays.length && !behind.length && !urgent.length) return null;
    return { title: `${DAY_NAMES[dow]}: ${todays.length} target${todays.length === 1 ? '' : 's'}`, body: lines.join(' · '), tag: 'morning' };
  }

  const left = remainingToday(plan, wt, dow);
  if (!left.length) return null;
  return { title: `${left.length} target${left.length === 1 ? '' : 's'} left today`, body: names(left), tag: 'evening' };
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
      if (url.pathname === '/api/test-push' && request.method === 'POST') {
        const result = await pushAll(env, { title: 'Reminders are working', body: 'You’ll get your morning and evening reminders here.', tag: 'test', url: '/' });
        return json(result);
      }
      if (url.pathname === '/api/preview-reminder' && request.method === 'GET') {
        const when = nowLocal();
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
