# Meta / Instagram Setup Guide

This document exists because getting from "I have a Meta Business account" to
"this app can send and receive Instagram DMs" took a long, expensive series of
live-verified false starts. Follow this guide in order and each of those
mistakes is avoidable.

## Which Meta product this app uses (read this first)

Meta currently ships **two different, non-interoperable** products, both
informally called "the Instagram API," and it is very easy to end up on the
wrong one:

| | Instagram API with **Facebook Login** (what this app uses) | Instagram API with **Instagram Login** (NOT this app) |
|---|---|---|
| API host | `graph.facebook.com` | `graph.instagram.com` |
| Requires a linked Facebook Page | Yes | No |
| Token type needed | Facebook **Page** Access Token | Instagram User Access Token |
| Token prefix (informal, but reliable in practice) | `EAA...` | `IGAA...` |
| Dashboard screen | App Dashboard → Instagram → **API setup with Facebook Login** | App Dashboard → Instagram → API setup with Instagram Login |

If you ever generate a token starting with `IGAA` and it's rejected by
`graph.facebook.com` with `"Cannot parse access token"`, you were on the
wrong screen -- that error is not about an expired or malformed token, it's
Meta's token parser refusing a token from a different product's namespace
entirely. This happened three times before it was diagnosed; do not repeat
it.

## The correct token flow

The Dashboard does **not** hand you a ready-to-use Page Access Token with one
click. Per Meta's own documented flow (`instagram-api-with-facebook-login/get-started/`,
sections "3. Get a User Access Token" and "4. Get the User's Pages"), it is a
two-step derivation:

1. **Get a User Access Token** via the standard OAuth dialog (see below).
2. **Exchange it for a long-lived User Access Token** -- do this before the
   next step, or the derived Page token will inherit a short (~hours)
   session and expire the same day. (This was missed once already; the
   resulting Page token expired within four hours of being derived.)
   ```
   GET https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<SHORT_LIVED_USER_TOKEN>
   ```
3. **Derive the Page Access Token** from the long-lived User token:
   ```
   GET https://graph.facebook.com/v21.0/me/accounts?access_token=<LONG_LIVED_USER_TOKEN>
   ```
   The response's `data[]` array lists every Page the user administers; each
   entry's `access_token` field is the real, usable Page Access Token. This
   is the value that goes into `INSTAGRAM_PAGE_ACCESS_TOKEN`. **Not** the raw
   User token from step 1/2 -- that token resolves `/me` to a person, not a
   Page, and is not valid for `/me/messages` or `/subscribed_apps`.

An App Access Token (`{app-id}|{app-secret}`) **cannot** substitute for any
of this -- confirmed live: calling `/subscribed_apps` with one returns
`"A user access token is required to request this resource."` (code 102).

## Exact OAuth URL and required scopes

Register a redirect URI first: App Dashboard → your app → **Facebook Login
for Business** → Settings → add a Valid OAuth Redirect URI. It doesn't need
to serve anything -- you only need to read the `code` parameter out of the
browser's address bar afterward, even if the page 404s. `https://ai.nuteco.uz/`
is a reasonable choice.

```
https://www.facebook.com/v21.0/dialog/oauth?client_id=<APP_ID>&redirect_uri=<REDIRECT_URI>&scope=pages_show_list,business_management,instagram_basic,instagram_manage_comments,instagram_manage_messages,pages_read_engagement,public_profile,pages_manage_metadata,pages_messaging
```

| Scope | Why |
|---|---|
| `pages_show_list` | Enumerate Pages via `/me/accounts` |
| `instagram_basic` | Baseline Instagram professional account access -- documented requirement for the `messages` webhook field |
| `instagram_manage_messages` | Core permission -- read/respond to Instagram DMs |
| `pages_read_engagement` | Documented requirement for the `messages` webhook field |
| `pages_manage_metadata` | Documented requirement for the `messages` webhook field; also what `GET /{page-id}/subscribed_apps` demands directly (confirmed live) |
| `pages_messaging` | Not in Meta's Instagram-specific webhook-fields doc table, but named explicitly by the live `POST /{page-id}/subscribed_apps?subscribed_fields=messages` error when absent. Documentation and live behavior disagreed here; included defensively since requesting an unneeded scope costs nothing and a missing one costs a whole re-consent round. |
| `business_management`, `public_profile`, `instagram_manage_comments` | Already-granted permissions carried forward so a re-consent doesn't silently drop them |

After completing the flow above, run through steps 2–3 (long-lived exchange,
then `/me/accounts`) before writing anything to `.env`.

## Verifying each piece (static description -- see TROUBLESHOOTING.md for
## live command examples)

In order, each of these should be checked before moving to the next:

1. `GET /me?access_token=<token>` -- confirms the token is real and live.
2. `GET /me/accounts?access_token=<user_token>` -- lists Pages + their Page tokens.
3. `GET /{page-id}?fields=id,name,instagram_business_account&access_token=<page_token>` -- confirms the Page and its linked Instagram Business Account ID.
4. `GET /{page-id}/subscribed_apps?access_token=<page_token>` -- current subscription status (requires `pages_manage_metadata`).
5. `POST /{page-id}/subscribed_apps?subscribed_fields=messages&access_token=<page_token>` -- subscribes the Page (requires `pages_manage_metadata` + `pages_messaging`, per the discrepancy noted above).
6. `GET /{app-id}/subscriptions?access_token={app-id}|{app-secret}` -- app-level webhook registration state. This is separate from (4)/(5) and does **not** get fixed by any OAuth scope -- it requires the Meta Dashboard's Webhooks product (Callback URL + Verify Token) to be configured, which in turn requires the server to already be live and answering the GET verification handshake. See the Dashboard steps in README.md's Deployment section.

## Known-real production values (as of the last verification pass)

- App ID: `1004232935766895`
- Business Portfolio: Farier Studio (`253345331189001`)
- Facebook Page: "Nuteco premium Ореховые пасты и мука", Page ID `106202425126533`
- Instagram Business Account ID: `17841406082256694` (`@nuteco_premium`)
- Domain: `ai.nuteco.uz`

**A previously-recorded Page ID, `734801256393570`, is wrong** -- it does not
exist or is not accessible to this account at all (Graph API error 100,
confirmed live). If you see this value anywhere, it's stale; the correct one
is `106202425126533` above.
