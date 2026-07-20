# Environment Variables

The authoritative list is `src/config/config.ts` -- it's the one place in
the codebase that reads `process.env`, and every variable below is verified
against it directly (cross-checked mechanically: every name `config.ts`
reads exists in `.env.example`, and every name in `.env.example` is actually
read by `config.ts` -- zero mismatches, zero unused entries, as of the last
audit pass).

## Always required

| Variable | Source | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) | |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | |
| `MANAGER_NOTIFICATION_CHAT_ID` | The Telegram chat/group ID that receives escalations | |

## Always optional

| Variable | Default | Notes |
|---|---|---|
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | none | Strongly recommended in production -- without it, anyone who discovers the webhook URL can send fake updates. `openssl rand -hex 32`. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | |
| `KNOWLEDGE_BASE_DIR` | `./knowledge` | |
| `PROMPTS_DIR` | `./prompts` | |
| `DATABASE_PATH` | `./data/nuteco.db` | Under Docker, this path is inside the container; `docker-compose.yml` mounts a named volume at `/app/data` so it persists. |
| `PORT` | `3000` | |
| `TOKEN_HEALTH_CHECK_INTERVAL_MS` | `3600000` (1 hour) | How often the startup token/health checks (Telegram, Instagram, Gemini) re-run for as long as the process keeps running, so a credential that expires or gets revoked after startup is caught and logged (`token_health_check.failed`) instead of only surfacing on the next real customer message. Set to `0` to disable the periodic re-check; the checks still always run once at startup. |

## Instagram -- all five, or none (see config.ts's `parseInstagramConfig`)

Setting **any** `INSTAGRAM_*` variable makes every other one in this group
required -- a partial set fails startup with a clear list of what's missing,
by design (a typo'd variable name is far more likely than an intentionally
partial setup).

| Variable | Default | Notes |
|---|---|---|
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | — | See `META_SETUP.md` for the full acquisition flow -- this is not a value you copy from a single Dashboard button. |
| `INSTAGRAM_APP_SECRET` | — | App Dashboard → Settings → Basic. |
| `INSTAGRAM_VERIFY_TOKEN` | — | You generate this yourself (`openssl rand -hex 32`); it also has to be entered verbatim into the Meta Dashboard's Webhooks product. |
| `INSTAGRAM_PAGE_ID` | — | The Facebook Page ID, not the Instagram username or the Instagram Business Account ID -- these are three different identifiers. See `META_SETUP.md` for the current confirmed value and a historically-wrong value to watch out for. |
| `INSTAGRAM_GRAPH_API_VERSION` | `v21.0` | |

## Setting variables under Docker

`docker-compose.yml` uses `env_file: .env` -- the file is read from the host
at container **start** time and injected as environment variables. It is
never copied into the image (`.dockerignore` excludes it explicitly), so
rebuilding the image doesn't require rebuilding secrets into it, and the
image itself contains no secrets if it's ever pushed to a registry.

## What NOT to do

- Do not commit `.env` (already gitignored, verified empty in every commit
  in this repo's history).
- Do not add secrets to `.env.example` -- it exists precisely so it's safe
  to commit; every value in it is either blank or a genuinely public default
  (like `PORT=3000` or `INSTAGRAM_GRAPH_API_VERSION=v21.0`).
- Do not put `.env` values directly into `Dockerfile` `ENV` instructions --
  that bakes them into image layers permanently, retrievable by anyone with
  the image even after the value is rotated.
