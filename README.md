# Study planner

A phone app for the Winter 2026–27 weekly study plan: daily targets with overdue warnings, real deadlines, an exam countdown with exam-prep mode, effort tagging, weekly stats, and morning/evening reminders. Works offline and syncs between devices.

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

- `public/` — the app (plain HTML, CSS and JS; no build step). `shared.js` holds the default plan, dates and exam logic, and is also used by the server.
- `src/worker.js` — API (`/api/state`, `/api/sync`, push subscribe), and the scheduled reminder job.
- `src/push.js` — Web Push (VAPID + aes128gcm) with WebCrypto only.
- `wrangler.jsonc` — Worker config: D1 binding, static assets, cron every 15 minutes.

## Local development

```
npm install
printf 'APP_KEY=dev\nVAPID_PUBLIC=...\nVAPID_PRIVATE=...\n' > .dev.vars
npm run dev
```

After changing files in `public/`, bump `CACHE` in `public/sw.js` so phones pick up the new version.
