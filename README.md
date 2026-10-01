# MEOW — you heard me.

A personal reminder web app. Type a reminder in plain English, and MEOW fires
it to your phone over **Telegram** at the right moment, with **Email** as a
backup. The whole thing is a website — a browser dashboard on top of a small
Node.js/Express backend — and notification channels are pluggable, so more
can be added later.

```
"remind me to call dad tomorrow 9am"   →  ⏰ fires tomorrow 9:00 AM
"every monday 9am standup"             →  🔁 repeats every Monday
"submit report in 2 hours"             →  ⏰ fires in 2 hours
```

Built with Node.js, Express, and a brutalist royal-navy-and-gold front end.

---

## Getting started

```bash
npm install
npm start            # or: node server.js
```

Open http://localhost:3000.

Times are interpreted and shown in `Asia/Kolkata` by default. Change it with
the `TZ` env var or the `process.env.TZ` line at the top of `server.js`.

The app works immediately with zero configuration (reminders are logged to the
on-screen activity feed). Add Telegram and/or email to get real notifications.

---

## Features

- **Plain-English scheduling** — one-time and recurring reminders
  (`tomorrow 9am`, `in 2 hours`, `every weekday 9am`).
- **Live dashboard** — next-reminder countdown, agenda, activity ledger.
- **Per-browser identity** — each browser that presses 🐾 GET THE MEOW is
  linked to its own person via a one-time Telegram code. "Me" is per-browser:
  everyone sees and edits only their own reminders, and nobody (except the
  admin) can see who else is enrolled.
- **Telegram via a fixed bot** — one bot serves everyone; a person taps
  **Start** (or sends their link code) and their browser is theirs. No tokens
  or chat ids for end users.
- **Self-only reminders** — a person can create reminders only for themselves;
  delivery goes to their own Telegram chat.
- **Email backup channel** — SMTP (Gmail app password supported).
- **Admin panel** (password protected) — manage bots, delivery channels, the
  enrolled-users roster (admin-visible only), and the admin password.
- **Durable storage** — MongoDB (cloud) or local files, see below.

---

## Architecture

| Part | File | What it does |
|---|---|---|
| Front end | `public/index.html`, `style.css`, `app.js` | Dashboard: countdown, add box, agenda, activity |
| Admin UI | `public/admin.html` | Password-protected management page |
| Server / API | `server.js` | Express routes, admin sessions, startup |
| Storage | `store.js` | Data access layer (Mongo + local fallback) |
| Parser | `parser.js` | Natural language → `{ title, dueAt, recurring? }` |
| Scheduler | `scheduler.js` | Fires due reminders, rolls recurring ones |
| Bot listener | `telegram-poller.js` | Long-polls Telegram, enrolls users on Start |
| Channels | `channels/telegram.js`, `email.js`, `demo.js` | Where notifications are actually sent |

### Lifecycle of a reminder

1. The dashboard posts to `/api/tasks`.
2. `parser.js` resolves it to `{ title, dueAt, recurring? }` and `store.js`
   persists it.
3. `scheduler.js` ticks every 15 seconds. When a task is due, every
   configured channel sends it, the event is logged, and:
   - one-time tasks are marked done;
   - recurring tasks roll to their next occurrence.

---

## Where data lives

Two interchangeable backends, selected automatically:

1. **MongoDB Atlas (recommended).** Set it up once from **Admin → DATABASE**:
   paste a connection string and hit CONNECT. Data then lives in the cloud, so
   redeploying the app never touches it, and you can move the app to another
   machine. Existing local data is migrated in on first connect.
   - Free setup: MongoDB.com → free **M0** cluster → *Database Access*
     (create a user) → *Network Access* (add `0.0.0.0/0`) → *Connect →
     Drivers* → copy the `mongodb+srv://…` string.
2. **Local files (fallback).** Until a database is configured — or if it's
   unreachable — data is stored in `~/.meow/data`. Override the folder with
   `MEOW_DATA_DIR`.

The connection string can also be supplied as `MEOW_MONGO_URI` instead of (or
in addition to) the admin field.

---

## Admin access

Bots, delivery channels, enrolled users, the database, and the admin password
are all managed from the **Admin** page (top-right of the dashboard).

- **First run:** no password is stored in the code. The app generates a
  one-time admin password and **prints it to the server console** on startup.
  Log in with it, then change it (Admin → Change password).
- **Or set it yourself:** start with `MEOW_ADMIN_PASSWORD=<password>` and it's
  used as the initial password. It also works as a reset path later.
- The password is stored **hashed** in your data store (Mongo or local config) —
  never in the repo.

## Setting up channels

### Telegram (a fixed bot, users just press Start)

1. In Telegram, message **@BotFather** → `/newbot` → copy the **token**.
2. Open **Admin** → **Bots** → paste the token → **ADD BOT**. The app looks
   up the bot's `@username` and builds its link.
3. Share the page's **🐾 GET THE MEOW** button (or the bot link). Whoever taps
   it lands on the bot in Telegram, presses **Start**, and is enrolled.

How routing works: on Start, Telegram hands the bot that person's unique chat
id, which is stored against their enrollment. Each reminder is addressed to
one enrolled person and delivered to exactly that chat id — so many people can
use the same bot without any cross-delivery.

### Email (backup)

- For Gmail: enable 2-step verification and create an **App Password**
  (Google Account → Security → App passwords).
- Admin → **Delivery channels → Email**: host `smtp.gmail.com`, port `587`,
  your address as user/from/to, the app password as the password.
- Use **Send test → Email** to verify.

---

## Running it somewhere reliable

The scheduler and the bot listener only work while the Node process is
running, so the host must stay up (and the DB must be reachable):

- **Now:** keep `npm start` running on your machine.
- **Long term (hosted, free):** an always-on container PaaS such as
  **Deplexo** (free tier: 1 app, 0.25 CPU, 128 MB — this app idles around
  ~55 MB). It deploys straight from your Git repo on every push with HTTPS
  included. Set `MEOW_MONGO_URI` (the container disk is ephemeral) and
  `MEOW_DATA_DIR=/data` (the one writable volume). Full steps: see `DEPLOY.md`.
- **Long term (your own):** a small always-on host — a VPS or a Raspberry Pi.
  Pure serverless (Vercel/Netlify *functions*) won't work, because the
  scheduler and long-poller need a continuously running process.

Useful env vars: `TZ`, `PORT`, `MEOW_MONGO_URI`, `MEOW_ADMIN_PASSWORD`,
`MEOW_DATA_DIR`.

---

## Adding a channel

Each channel is one small module in `channels/` exposing:

```js
{
  id: 'whatsapp',
  name: 'WhatsApp',
  isConfigured() { /* credentials present? */ },
  async send(task) { /* deliver it */ }
}
```

Register it in `channels/index.js` and the scheduler and dashboard pick it up.
Note: WhatsApp/Instagram/Facebook don't offer a free, official "send to
anyone" API like Telegram and Email do, so they'd need official business APIs
(approval + templates) or carry ban risk.

---

## Examples

```
remind me to submit the report tomorrow 9am
buy groceries in 2 hours
every friday 6pm call mom
every weekday 9am standup
take a break in 15 minutes
```
