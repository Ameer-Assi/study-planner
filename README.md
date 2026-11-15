# Study planner

A phone app for planning the study week around goals. On Saturday you list what you want done next week, then put each goal on the days you'll work on it. A goal can sit on several days, which splits it into parts, and each part can carry a note such as "questions 1–3".

- **Plan:** hold a goal and drag it to a day, or tap it and pick the days. Goals marked "Every week" come back each week, ready to place. The grid button shows the whole week as a timetable, with classes and goals by the hour.
- **Today:** the parts placed on today, with a tick box each. Unticked parts from earlier days show as behind, and goals with no day are flagged. The Timeline switch shows the day by the hour.
- **Times:** a goal's part can have a start time and a length, both optional. In a timeline, hold a part and drag it into a free gap, drag the bar at its bottom to change the length, or set both in the goal's sheet. Each class has a length too, set in Settings.
- **Reminders:** a morning summary and an evening nudge. On Saturday they also say if next week isn't planned.

Works offline and syncs between devices.

Runs free on Cloudflare: a Worker serves the app and the API, D1 stores your data, and a cron trigger sends reminders over Web Push.

## Setup

1. **Cloudflare Worker.** Workers & Pages → Create → Import a repository → pick `study-planner`. Keep the project name `study-planner` and the default build settings. It deploys on every push to `main`.
2. **Open the app** at the `*.workers.dev` address Cloudflare shows, on your phone in Safari.
3. **Generate keys** on the setup screen. Add the three values as **Secrets** in the Worker: Settings → Variables and Secrets → Add. Names: `APP_KEY`, `VAPID_PUBLIC`, `VAPID_PRIVATE`. Then deploy.
4. Back in the app, tap **I've added them**.
5. **Install it:** Share → Add to Home Screen. Open it from the Home Screen icon.
6. **Reminders:** Settings → Turn on reminders → Send a test. On iPhone this needs iOS 16.4 or later and the app opened from the Home Screen.

The database tables are created automatically on the first request.

## Files

- `public/` — the app (plain HTML, CSS and JS; no build step). `shared.js` holds the plan format, the goal logic and the dates, and is also used by the server.
- `src/worker.js` — API (`/api/state`, `/api/sync`, push subscribe), and the scheduled reminder job.
- `src/push.js` — Web Push (VAPID + aes128gcm) with WebCrypto only.
- `wrangler.jsonc` — Worker config: D1 binding, static assets, cron every 15 minutes.
- `scripts/preview.mjs` — builds a single-file preview that runs without a server: `node scripts/preview.mjs preview.html`.

Plans saved by the first version (fixed targets on each day) are converted to goals the first time the server loads them. The old plan is kept in the database under the key `plan-v1`.

## Local development

```
npm install
printf 'APP_KEY=dev\nVAPID_PUBLIC=...\nVAPID_PRIVATE=...\n' > .dev.vars
npm run dev
```

After changing files in `public/`, bump `CACHE` in `public/sw.js` so phones pick up the new version.
