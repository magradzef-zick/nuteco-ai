# Nuteco AI Assistant

A customer-service assistant for Nuteco Premium, a nut butter and nut flour producer based in Tashkent, Uzbekistan. It answers product, delivery, and payment questions over Telegram and Instagram Direct Messages from a maintained knowledge base, collects order details, and hands off anything sensitive — complaints, wholesale orders, discount requests, medical questions — to a human.

The assistant is not meant to replace staff. It absorbs the repetitive front-line questions and leaves everything that requires judgment, money, or an apology to a person.

## Features

- **Telegram and Instagram webhook integration** — small, framework-free HTTP handlers that acknowledge the platform immediately and process updates asynchronously, so slow processing never causes a delivery retry. Both run on the same process and share the same conversation engine; Instagram support is entirely optional and off by default (see Environment variables).
- **Knowledge-base-grounded replies** — the assistant only answers from a set of per-topic markdown files, injected directly into the model's context. Editing a file changes what the assistant knows within about a minute, with no redeploy.
- **Deterministic hallucination guardrail** — every reply is checked after generation: any price, percentage, or quantity that isn't actually backed by the knowledge base blocks the reply and triggers an escalation instead. Amounts are compared by digits, so a reformatted figure (`25 000` for the price list's `25.000`) is still checked rather than slipping past unrecognized.
- **Price-catalogue check** — the client's price list is parsed back out of the same text the model was given, and every price the assistant states is held to the exact product row and size column it claims. A real catalogue price attached to the wrong product, or a 1 kg price quoted for a 500 g jar, is caught — "the number exists somewhere" is not enough once a full price list is in the knowledge base.
- **Deterministic B2B/wholesale detection** — a keyword-based pre-filter runs before the model is even called, so an unambiguous wholesale signal escalates immediately regardless of what the model would have judged.
- **Message debouncing** — rapid-fire messages from the same customer are coalesced into a single batch, and duplicate or retried webhook deliveries (Telegram redelivery, Instagram's batched events) are handled idempotently.
- **Trilingual fallback messages** — Russian, Uzbek, and English. Escalation and error messages are chosen by a deterministic language detector, independent of the model, so a customer still gets a reply in their own language even when the model is unreachable.
- **Manager escalation** — any escalation (deterministic or model-judged) sends a summary to a manager's Telegram chat, best-effort and non-blocking.
- **Startup validation** — the process refuses to start if the knowledge base or system prompt is empty, the database isn't reachable, the Telegram token is invalid, or the model API isn't reachable, with a clear description of what's wrong.

## Architecture

The codebase follows a straightforward dependency-inversion layout: the conversation engine depends only on interfaces, and `composition.ts` is the single place concrete implementations are chosen and wired together.

```
Telegram webhook  → parseUpdate          ─┐
                                           ├→ MessageDebouncer → ConversationEngine → PlatformRoutingMessageSender ─┬→ Telegram
Instagram webhook → parseWebhookEvent    ─┘                          │                                            └→ Instagram
                                                                      │
                                                    ┌─────────────────┼─────────────────┐
                                                    │                 │                 │
                                             LlmProvider      CustomerIdentity   ConversationState
                                             (Gemini)           Repository          Repository
                                                                (SQLite)             (SQLite)
```

- `src/adapters/` — platform-specific code, one subdirectory per platform (`telegram/`, `instagram/`). Each converts its platform's payloads into a normalized shape the engine understands; nothing above this layer knows Telegram or Instagram exist. `PlatformRoutingMessageSender` dispatches an outgoing reply to the right platform based on the `<platform>:<id>` prefix every `customerId` already carries — adding a platform means registering one more entry here, not touching the engine.
- `src/engine/` — the conversation engine itself, plus the pieces around it: message debouncing, language detection, the B2B pre-filter, the hallucination guardrail, and fallback messages. Platform-agnostic — it depends only on the `MessageSender` interface, never on a concrete platform.
- `src/llm/` — the `LlmProvider` interface and the Gemini implementation. Swapping providers means adding one class and changing one line in `composition.ts`.
- `src/storage/` — `CustomerIdentityRepository` (long-lived: is this a returning customer, are they B2B) and `ConversationStateRepository` (short-lived per-conversation state). Each has a SQLite implementation and an in-memory one used in tests.
- `src/knowledge/` and `src/prompts/` — load markdown files from disk into the text sent to the model, with a short cache so a burst of messages doesn't hit the filesystem repeatedly.
- `src/startup/` — checks that everything the app depends on actually works before it starts accepting traffic.
- `src/composition.ts` — the composition root. Its `handleParsedUpdate` function is the platform-agnostic core (debounce, dispatch, error recovery) shared by both webhook entrypoints, so that logic exists exactly once regardless of how many platforms are wired up.

Instagram support is additive and optional: with no `INSTAGRAM_*` variables set, the app behaves exactly as a Telegram-only deployment always has (no second route, no extra startup check, no behavior change).

The knowledge base is injected into every call in full ("full-context stuffing") rather than retrieved from a vector store — the content is small enough that this is simpler and more predictable than a retrieval pipeline, and it avoids retrieval misses on exact facts like prices.

## Tech stack

- **Runtime:** Node.js (LTS), TypeScript in strict mode, no web framework — the webhook handlers are built directly on `node:http`.
- **Messaging:** Telegram Bot API and Meta's Graph API (Instagram Direct Messages), both via plain `fetch`-based clients (no SDK dependency).
- **Database:** SQLite via `better-sqlite3` (synchronous, embedded, no separate database server).
- **LLM:** Google Gemini, via a plain `fetch`-based client (no SDK dependency).
- **Testing:** Node's built-in test runner (`node:test`), no external test framework.
- **Tooling:** `tsx` for running TypeScript directly in development, `tsc` for type-checking/build.

## HTTP routes

| Route | Purpose |
|---|---|
| `POST /telegram/webhook` | Telegram update deliveries. |
| `POST /instagram/webhook` | Instagram Direct Message deliveries, plus the one-time `GET` verification handshake Meta performs when the callback URL is configured. |
| `GET /health` | Cheap liveness probe — confirms the server is accepting connections. |
| `GET /privacy` | The customer-facing privacy policy (`public/privacy.html`). Meta will not let an app be published without a reachable privacy policy URL, and an unpublished app receives no Instagram webhooks at all, so this route is a deployment dependency rather than paperwork. Read from disk per request, so the wording can be corrected without a redeploy. |

## Environment variables

Copy `.env.example` to `.env` and fill in the values below. [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) has the fuller reference, including Docker-specific notes on how these get into the container.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | From [@BotFather](https://t.me/BotFather). |
| `GEMINI_API_KEY` | Yes | — | From [Google AI Studio](https://aistudio.google.com/apikey). |
| `MANAGER_NOTIFICATION_CHAT_ID` | Yes | — | Telegram chat/group ID that receives escalation notifications. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | No | none | Strongly recommended in production. Checked on every incoming webhook request; without it, anyone who discovers the webhook URL can send fake updates. Generate with `openssl rand -hex 32`. |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Override if the default is renamed or deprecated. |
| `KNOWLEDGE_BASE_DIR` | No | `./knowledge` | Directory of markdown files the assistant answers from. |
| `PROMPTS_DIR` | No | `./prompts` | Directory containing the system prompt template. |
| `DATABASE_PATH` | No | `./data/nuteco.db` | SQLite file location. Parent directory is created automatically if missing. |
| `PORT` | No | `3000` | Port the webhook HTTP server listens on. |
| `TOKEN_HEALTH_CHECK_INTERVAL_MS` | No | `3600000` | How often the startup token/health checks (Telegram, Instagram, Gemini) re-run for as long as the process keeps running, so an expired/revoked credential is caught and logged proactively. `0` disables the periodic re-check. |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | No* | — | Page access token for the Instagram-linked Facebook Page (Meta App Dashboard, Messenger/Instagram product). |
| `INSTAGRAM_APP_SECRET` | No* | — | Your Meta app's App Secret. Verifies the `X-Hub-Signature-256` header on every webhook delivery — the Instagram equivalent of `TELEGRAM_WEBHOOK_SECRET_TOKEN`. |
| `INSTAGRAM_VERIFY_TOKEN` | No* | — | A random string you choose, entered into the Meta App Dashboard's webhook subscription form; echoed back on the one-time GET verification request. |
| `INSTAGRAM_PAGE_ID` | No* | — | The Instagram-linked Facebook Page ID. Used to subscribe the page to webhook events. |
| `INSTAGRAM_GRAPH_API_VERSION` | No | `v21.0` | Override if Meta deprecates the default. |
| `INSTAGRAM_GRAPH_BASE_URL` | No | `https://graph.facebook.com` | Which Graph host to call. Meta serves Instagram messaging from two hosts and the correct one is decided by how the token was issued, not by preference: `graph.facebook.com` for a Page token, `graph.instagram.com` for an Instagram-scoped token (one that starts with `IGAA`). Calling the wrong host fails with a permission error that never names the host as the cause. |

\* All `INSTAGRAM_*` variables are all-or-nothing: leave every one of them unset to run Telegram-only, or set all of them to also handle Instagram Direct Messages. Setting only some is a configuration error the app refuses to start with.

## Local development

Requirements: a recent Node.js LTS release, a Telegram bot token, and a Gemini API key.

```bash
npm install
cp .env.example .env
# edit .env with your values
npm start
```

`npm start` runs startup validation first (knowledge base loads, system prompt loads, database is queryable, the Telegram token is valid, Gemini is reachable) and refuses to start if any check fails.

Other useful commands:

```bash
npm test           # full test suite (unit + integration, no external framework)
npm run build      # type-check with tsc, no emitted output needed for development
```

## Deployment

Full detail (including a reference nginx config, healthcheck behavior, and volume/persistence notes) lives in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — this section is the short version.

**Docker (recommended):**

```bash
docker compose build
docker compose up -d
```

The container speaks plain HTTP on port 3000 — TLS termination still needs a reverse proxy or load balancer in front of it, same as the non-Docker path. `.env` is injected at container start (`env_file` in `docker-compose.yml`), never baked into the image. `GET /health` is a cheap liveness route (confirms the server is accepting connections, not that every downstream dependency is currently reachable) — the Dockerfile's `HEALTHCHECK` already uses it.

**Without Docker:** the process is a single long-lived Node server under a supervisor (systemd, pm2, etc.) — same environment variable requirements, same startup validation, same webhook registration steps below; just run `npm start` directly instead of the Docker commands above.

After deploying, register the Telegram webhook once so Telegram knows where to send updates:

```bash
npm run register-webhook -- https://your-domain.example/telegram/webhook
```

Re-run this if the domain changes or the webhook secret is rotated.

If Instagram is configured, two more one-time steps are needed (in this order). The full token-acquisition flow — including two non-obvious steps this project's own setup got wrong before it worked — is documented in [`docs/META_SETUP.md`](docs/META_SETUP.md):

1. In the Meta App Dashboard's Webhooks product, set the callback URL to `https://your-domain.example/instagram/webhook` and the verify token to the same value as `INSTAGRAM_VERIFY_TOKEN`. Meta calls the URL with a GET request at this point; the app must already be running to answer it.
2. Subscribe the page to the `messages` field:

   ```bash
   npm run subscribe-instagram-webhook
   ```

   Unlike Telegram's `setWebhook`, this does not register the URL itself — that's the Dashboard step above. It only tells Meta which fields to actually deliver for this page.

Hit an error partway through any of this? [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) documents the actual errors this project's own deployment ran into, with their real cause — several look like a broken token or bad config but aren't.

## Project structure

```
src/
  adapters/       platform-specific code (telegram/, instagram/) + PlatformRoutingMessageSender
  engine/         conversation engine, debouncer, guardrails, detectors
  llm/            LlmProvider interface + Gemini implementation
  storage/        identity/state repositories (SQLite + in-memory)
  knowledge/      markdown knowledge-base loader
  prompts/        system prompt loader
  startup/        startup validation checks
  observability/  structured logging
  config/         environment parsing/validation
  composition.ts  wires concrete implementations together
  index.ts        process entrypoint
tests/            one file per module, plus shared fakes in tests/support/
knowledge/        the live, per-topic knowledge base (edit to change what the assistant knows)
knowledge/prices.md  the client's price list — the only source of prices and sizes, and what the
                     catalogue guardrail checks every quoted price against (src/engine/priceCatalog.ts)
prompts/          the production system prompt
faq/              human-readable mirror of the knowledge base, not read by the running system
docs/             deployment, environment, Meta/Instagram setup, and troubleshooting reference
data/             SQLite database file (git-ignored, created automatically; a Docker volume under docker-compose)
Dockerfile, docker-compose.yml, .dockerignore   container deployment (see docs/DEPLOYMENT.md)
SERVER_DAY_CHECKLIST.md                         the exact, ordered list of what's left once the server is reachable
```

## License

Proprietary. All rights reserved.
