# Troubleshooting

Real errors hit during this project's setup, with their actual (sometimes
non-obvious) cause and fix -- not generic advice.

## `"Invalid OAuth access token - Cannot parse access token"` (code 190, no subcode)

**Not** an expired or malformed token in the usual sense. This exact
message, with **no `error_subcode`**, is what `graph.facebook.com` returns
when the token string is structurally from a *different Meta product's*
token namespace -- specifically, an `IGAA`-prefixed token from "Instagram
API with Instagram Login" (`graph.instagram.com`) used against
`graph.facebook.com`, which this codebase calls exclusively. Confirmed
directly: the same token that fails here returns `200 {"id":..., "username":...}`
against `graph.instagram.com/v21.0/me`. Fix: regenerate from **App
Dashboard → Instagram → API setup with Facebook Login** specifically, not
"API setup with Instagram Login." See `META_SETUP.md`.

Contrast with an actually expired token, which has a **specific subcode**:

```json
{"error":{"message":"Error validating access token: Session has expired on ...","type":"OAuthException","code":190,"error_subcode":463}}
```

## `"To subscribe to the messages field, one of these permissions is needed: pages_messaging"`

Happens on `POST /{page-id}/subscribed_apps?subscribed_fields=messages`.
Meta's own Instagram-webhooks documentation table lists
`instagram_basic, instagram_manage_messages, pages_manage_metadata,
pages_read_engagement, pages_show_list` as required for the `messages`
field -- `pages_messaging` is conspicuously absent from that table, but the
live API demands it anyway for this specific action. Documentation and live
behavior disagree here; trust the live error. Fix: re-run the OAuth consent
with `pages_messaging` included in `scope` (see `META_SETUP.md`'s exact URL).

## `"Requires pages_manage_metadata permission to manage the object"`

Happens on `GET /{page-id}/subscribed_apps` (checking current subscription
status, as opposed to setting one). Same root cause and fix as above --
`pages_manage_metadata` is the one Meta's own endpoint reference
(`graph-api/reference/page/subscribed_apps/`) documents directly for this
endpoint.

## `"A user access token is required to request this resource."` (code 102)

Happens if you try to use an App Access Token (`{app-id}|{app-secret}`) for
`/subscribed_apps`. Confirmed live -- there is no way around needing a real,
Page-derived User-flow token for this specific call. An App Access Token
*is* valid for other things (e.g. reading `/{app-id}` or
`/{app-id}/subscriptions`), just not this one.

## `Parameter error: You cannot send messages to this id` (code 100, not 200)

This is what an *invalid recipient* looks like on `POST /me/messages` --
and it's worth knowing what it's **not**: it's a completely different error
family (code 100, "parameter error") from the permission errors above (code
200, "permission error"). If you see code 100 here, the token's permissions
are fine; the problem is the specific recipient ID. Confirmed by testing:
message-sending itself does not require `pages_messaging` -- only the
subscription-management calls do.

## `GET /{app-id}/subscriptions` returns `{"data":[]}`

No app-level webhook is registered at all. This is a separate prerequisite
from every Page-level permission issue above -- it means the Meta App
Dashboard's Webhooks product (Callback URL + Verify Token) has never been
successfully configured, which itself requires the server to already be
live and answering Meta's GET verification handshake. If this returns
empty, don't debug Page-level permissions further until the Dashboard
webhook step is done and the server is reachable.

## The production domain doesn't respond at all (timeout, not "connection refused")

Checked from an external vantage point with `curl`, raw `nc`, and `ping`,
all timing out identically on every port (80, 443, and the app's own
configured port) -- that specific combination (silent timeout rather than
an instant refusal, and *nothing* responding, not just the webhook path)
points at the host itself being unreachable at the network layer, not an
application or TLS misconfiguration. In this project's case the actual
cause turned out to be the VPS being suspended for non-payment -- worth
checking hosting billing status before debugging Docker, nginx, or DNS.

A genuine TLS/certificate problem looks different: the TCP handshake
completes, then the TLS handshake fails with a specific certificate error.
A misconfigured reverse proxy looks different too: the connection completes
and you get a real (if wrong) HTTP response, not a timeout.

## `pm2 restart` doesn't pick up a new `.env` value

`pm2 restart <name>` alone reuses the environment PM2 cached at first
start. Use `pm2 restart <name> --update-env`, or the value silently stays
stale even though the file on disk is correct.

## Startup fails immediately, even though `.env` "looks right"

`npm start` loads `.env` itself if the file is present (see
`src/shared/loadEnvIfPresent.ts`) -- confirm there isn't a *second*, stale
`.env` being picked up from a different working directory (this happened
once in local development: a `.env.save` file, an editor crash-recovery
artifact, sat alongside the real `.env` with old values -- harmless since
it's never read by anything, but confusing to find). Also confirm the
process actually has read permission on the file if running as a non-root
container user. Inside Docker, `.env` is deliberately excluded from the
image (see `.dockerignore`) and variables are injected via
docker-compose's `env_file` directive instead -- `loadEnvIfPresent` is a
no-op there, which is expected.
