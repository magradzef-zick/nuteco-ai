# Deployment

Two supported paths: Docker (recommended, described here in full) or the
process directly under a supervisor like PM2 (see README.md's Deployment
section for that shorter, original path -- still valid, still works exactly
as before, nothing about it changed by adding Docker support).

## Prerequisites

- Docker and Docker Compose installed on the server.
- A publicly reachable HTTPS domain pointing at the server (`ai.nuteco.uz` in
  production). TLS is **not** terminated by this container -- something in
  front of it (nginx, Caddy, a load balancer) must do that; the container
  only speaks plain HTTP on port 3000.
- `.env` populated on the server (see ENVIRONMENT.md) -- never committed,
  never baked into the image, only ever injected at container start.

## Deploy

```bash
git pull
docker compose build
docker compose up -d
docker compose logs -f app   # watch startup validation
```

Startup validation runs before the server binds its port, exactly as it does
outside Docker (see `src/startup/validateStartup.ts`) -- a bad token or
missing variable fails loudly here, in the logs, not silently.

## Reverse proxy (TLS termination)

The container listens on `3000` (plain HTTP). Example nginx config
terminating TLS and proxying to it -- adapt paths/domain, this is a
template, not something pulled from the live server (no access to it from
here to compare against):

```nginx
server {
    listen 443 ssl;
    server_name ai.nuteco.uz;

    ssl_certificate     /etc/letsencrypt/live/ai.nuteco.uz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.nuteco.uz/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name ai.nuteco.uz;
    return 301 https://$host$request_uri;
}
```

## Restart policy and process management

`docker-compose.yml`'s `restart: unless-stopped` handles crash recovery --
no PM2 needed inside the container (PM2 and a container's own restart policy
serve the same purpose; running both is redundant). If you deploy without
Docker instead, PM2 remains the right tool -- see README.md.

## Health checks

`GET /health` (added specifically for this) returns `200 {"status":"ok"}`
the moment the HTTP server is accepting connections. It deliberately does
**not** re-check the database, Telegram, Gemini, or Instagram on every probe
-- those are all gated by startup validation before the process ever starts
listening, and re-checking live third-party APIs on every health probe would
make the healthcheck itself a source of false negatives during a transient
API hiccup. Docker's `HEALTHCHECK` in the Dockerfile already uses this route.

## Persistence

The SQLite database (customer identity + conversation state) lives in a
named Docker volume (`nuteco-data`, mounted at `/app/data`) so it survives
`docker compose down` / container recreation. It does **not** survive
`docker compose down -v` (which explicitly removes volumes) or a full host
rebuild -- back it up separately if that data matters beyond its own TTL
expiry (conversation state already expires on its own; see
`ConversationStateRepository`).

## Migrations

None exist and none are needed -- the schema is three small tables created via
`CREATE TABLE IF NOT EXISTS` on every startup (`src/storage/sqlite/connection.ts`),
which is idempotent and safe to run on every boot. If the schema ever needs
to evolve beyond additive `IF NOT EXISTS` changes, that's the point to
introduce a real migration tool -- not before, for a three-table schema with
no history of change.

## One-time steps after first deploy

Both are one-time, not per-deploy -- see `SERVER_DAY_CHECKLIST.md` for the
exact order relative to everything else:

```bash
docker compose exec app npm run register-webhook -- https://ai.nuteco.uz/telegram/webhook
docker compose exec app npm run subscribe-instagram-webhook   # only if INSTAGRAM_* is set
```

## What I could not verify

Docker isn't installed in the environment these artifacts were authored in,
so the Dockerfile and docker-compose.yml have not actually been built or
run -- they're written against well-established, verifiable patterns
(official Node image, standard multi-layer caching, Node's built-in `fetch`
for the healthcheck since slim images don't include curl/wget), but a real
`docker compose build && docker compose up` should be the first thing done
once the server is back, before anything else in `SERVER_DAY_CHECKLIST.md`.
