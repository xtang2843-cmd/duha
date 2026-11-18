# duha

A dark, mint-accented crypto market dashboard — **full stack**, no build step.

- **Frontend:** static HTML/CSS/JS, custom design system, responsive down to 390px.
- **Backend:** Node.js (24+), zero runtime dependencies, built-in `node:http`.
- **Database:** SQLite via `node:sqlite` (file on disk, WAL mode).
- **Live data:** CoinGecko, proxied and cached by the server. The browser never
  hits CoinGecko directly unless the backend is unreachable.

## Run locally

```bash
npm start
```

Open <http://127.0.0.1:3000>. No `npm install` needed — there are no packages.

Optional `.env` (see `.env.example`):

```bash
cp .env.example .env
```

Useful scripts:

```bash
npm run dev     # restart on file changes
npm run check   # syntax-check server.js and app.js
```

If you open `index.html` as a file, the site still renders with demo data, but
server features (newsletter, cross-reload watchlist sync) are unavailable.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check for hosting platforms |
| `GET` | `/api/markets` | Top 12 coins, proxied + cached for 60s |
| `GET` | `/api/global` | Global stats, cached for 5 minutes |
| `GET` | `/api/watchlist` | Watchlist for this browser (HttpOnly cookie) |
| `PUT` | `/api/watchlist` | `{ "coins": ["bitcoin", "solana"] }` |
| `POST` | `/api/subscribe` | `{ "email": "you@example.com" }` |

Examples:

```bash
curl http://127.0.0.1:3000/api/markets
curl -c jar.txt http://127.0.0.1:3000/api/watchlist
curl -b jar.txt -X PUT -H 'Content-Type: application/json' \
  --data '{"coins":["bitcoin","ethereum"]}' \
  http://127.0.0.1:3000/api/watchlist
```

Security: HttpOnly/SameSite session cookie, same-origin write checks, input
validation, 16KB body limit, per-IP rate limits, CSP and hardening headers,
and a strict static-file allowlist (server code and the database are never
served).

## What is stored

- **Watchlist** — per anonymous browser session, in the `watchlists` table.
  The browser also keeps a local copy so the UI works offline.
- **Newsletter** — email addresses go into the `subscribers` table. The form
  is labelled as a demo: **no emails are sent** until you connect a provider.
- No accounts, analytics, or third-party trackers.

The SQLite file lives at `data/duha.db` by default and is gitignored.

## Deploy

The site needs a Node host with a persistent disk (or a database). Three
ready-made paths:

### 1. VPS + Docker + Caddy (recommended, domain + HTTPS included)

Requires a server with Docker and ports 80/443 open.

1. Point your domain's DNS **A record** at the server's public IPv4 address.
2. On the server, copy this folder and create `.env`:

   ```bash
   DOMAIN=duha.yourdomain.com
   SITE_URL=https://duha.yourdomain.com
   ```

3. Start the stack:

   ```bash
   docker compose up -d --build
   ```

Caddy obtains and renews a Let's Encrypt certificate automatically. The
database is kept in the `duha-data` Docker volume. Update with
`docker compose up -d --build` after pulling changes.

### 2. Render

`render.yaml` is a Blueprint for a Node web service with the health check
already configured.

1. Push this folder to a GitHub/GitLab repository.
2. In Render: **New → Blueprint**, connect the repo, apply.
3. Add a custom domain in the service settings and follow Render's DNS
   instructions.

**Persistence note:** the free plan has an ephemeral filesystem, so the SQLite
database resets on every deploy. Attach a persistent disk (paid) and set
`DATA_DIR` to the mount path, or swap SQLite for Postgres before launch.

### 3. Fly.io

`fly.toml` includes a volume mount at `/data`.

1. Change `app` in `fly.toml` to a globally unique name.
2. Create and attach the volume:

   ```bash
   fly launch --no-deploy
   fly volumes create duha_data --size 1
   fly deploy
   ```

3. If SQLite cannot write to the mounted volume (non-root container), run
   `fly ssh console -C "chown -R node:node /data"` once.

### Domain checklist

- `A` record: `@` → server IPv4 (VPS) or the host's supplied target.
- `CNAME` record: `www` → the host's target (or `@` for a VPS).
- Wait for DNS propagation before the first certificate request.
- Set `SITE_URL` to the final HTTPS URL so logs and future links are correct.

Once the domain is live, add canonical/OG URLs to `index.html` for clean
social previews.

## Notes

- CoinGecko is proxied server-side, so browser CORS and rate limits stop
  being a problem. If the feed fails, the API returns `503` and the frontend
  falls back to clearly labelled demo data.
- Market data is indicative and not financial advice. duha is an independent
  demo project and is not affiliated with CoinGecko.
