# Server Day Checklist

Everything in this file requires the VPS to be online. Everything that
*doesn't* require that has already been done (see `docs/DEPLOYMENT.md`,
`docs/META_SETUP.md`, `docs/ENVIRONMENT.md` for the reasoning behind each
step below -- this file is deliberately just the ordered actions).

Run top to bottom. Don't skip ahead -- several steps are hard dependencies
of the ones after them (noted inline).

## 0. Confirm the VPS is actually back

```bash
ping -c 3 109.207.174.57
```
Last known IP. If the hosting provider assigned a **new** IP on
restoration, update the DNS `A` record for `ai.nuteco.uz` before continuing
-- everything below assumes the domain already resolves to the live server.

□ VPS responds to ping
□ `dig +short ai.nuteco.uz` matches the VPS's current IP (update the DNS `A` record first if not)

## 1. Deploy the code

```bash
git pull
docker compose build
docker compose up -d
docker compose logs -f app
```

Watch the logs for `startup.success`. If you see `startup.failed` instead,
stop here and fix the reported config issue before continuing -- everything
below assumes the process is actually running.

□ `docker compose build` succeeds
□ `docker compose up -d` succeeds
□ Logs show `startup.success` with no `startup.check_failed` entries
□ (First deploy only, or if this is untested) confirm the Docker build itself works at all -- see `docs/DEPLOYMENT.md`'s note that these artifacts were authored but never build-tested

## 2. Verify the server is reachable from the outside

```bash
curl -sI https://ai.nuteco.uz/health
```
Expect `200`. If this fails, the reverse proxy (nginx/Caddy) or firewall
needs attention before any Meta-side step below can possibly work -- Meta
needs the exact same reachability from its own servers that this command is
testing.

□ `https://ai.nuteco.uz/health` returns `200`

## 3. Telegram (independent of everything below -- do this regardless of Instagram's status)

```bash
docker compose exec app npm run register-webhook -- https://ai.nuteco.uz/telegram/webhook
```

□ Command reports success
□ Send a real Telegram message to the bot, confirm a reply arrives

## 4. Instagram -- complete the pending OAuth consent

The exact URL, scopes, and reasoning are in `docs/META_SETUP.md` -- do not
regenerate it from scratch, use what's already there.

□ Open the OAuth URL from `docs/META_SETUP.md`, log in as the Page admin, approve
□ Copy the `code` param from the resulting redirect URL
□ Exchange it for a long-lived User token (`docs/META_SETUP.md` step 2) -- do this before the next step, or the derived Page token expires within hours
□ Derive the Page Access Token via `GET /me/accounts` (`docs/META_SETUP.md` step 3)
□ Confirm the granted permissions include both `pages_manage_metadata` and `pages_messaging` (`GET /me/permissions`)

## 5. Update the running app with the new token

```bash
# edit .env on the server: INSTAGRAM_PAGE_ACCESS_TOKEN=<the derived Page token>
docker compose up -d --force-recreate app
docker compose logs -f app
```

□ Logs show `startup.success` with `instagramEnabled: true` and no Instagram-related `startup.check_failed`

## 6. Configure the Meta Dashboard webhook (requires step 2 and step 5 already done)

□ Meta App Dashboard → Webhooks product → Instagram → Callback URL: `https://ai.nuteco.uz/instagram/webhook`
□ Verify Token: the value of `INSTAGRAM_VERIFY_TOKEN` in `.env`, entered exactly
□ Save -- Meta immediately sends a GET verification request; this only succeeds because of steps 2 and 5

## 7. Subscribe the Page

```bash
docker compose exec app npm run subscribe-instagram-webhook
```

□ Command reports success
□ `GET /{page-id}/subscribed_apps` (see `docs/META_SETUP.md` for the exact call) shows the app subscribed to `messages`

## 8. End-to-end test

□ Send a real Instagram DM to `@nuteco_premium`
□ Confirm the bot replies
□ Tail `docker compose logs -f app` while doing this and confirm you see `webhook.received` → `conversation.started` → `conversation.ended` for the Instagram customer ID

## 9. Final smoke test

□ Telegram: send another message, confirm reply (regression check -- confirms Instagram setup didn't disturb Telegram)
□ Confirm `docker compose ps` shows the container healthy (not just running -- healthy, per the `HEALTHCHECK` in the Dockerfile)
□ Confirm `docker-compose.yml`'s `nuteco-data` volume exists and the SQLite file is being written to (`docker compose exec app ls -la /app/data`)

If every box above is checked, the Instagram integration is fully
operational in production.
