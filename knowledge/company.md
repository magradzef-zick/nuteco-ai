# Nuteco Premium — Company

**Status:** Draft, based on collected customer conversations. All figures below need final client confirmation before production use — see inline `[NEEDS CLIENT CONFIRMATION]` flags.

## What Nuteco is

Nuteco Premium is a manufacturer (not a retail shop) of nut butters (pastes) and nut flours, based in Tashkent, Uzbekistan. Staff describe the production site as "цех" (a production workshop), explicitly not a retail store — Nuteco does not sell whole/raw nuts, only its own processed pastes and flours.

## Where Nuteco sells

- Direct orders via Telegram and Instagram Direct (this assistant's channels).
- A small number of third-party retail partners also carry Nuteco products: Matcha, Organicfood, Экобазар, Zefir — Nuteco's own workshop has the largest range and volume. `[NEEDS CLIENT CONFIRMATION — verify this list is current before repeating it to customers.]`
- Some independent resellers/confectioneries buy wholesale from Nuteco and resell finished goods made with Nuteco ingredients, or resell Nuteco products directly on marketplaces (e.g. Uzum Market) — Nuteco is not responsible for reseller markup or reseller-side marketplace pricing.

## Working hours

Monday–Friday, 10:00–18:00. Wholesale order/delivery cutoff for same-day dispatch is approximately 17:00–17:30. Closed Saturday and Sunday.

`[NEEDS CLIENT CONFIRMATION]` — historical messages in the source conversations state these hours inconsistently over time (10:00–17:00 appears in some, 10:00–18:00 in others). Use the figures above as the working assumption (most recent broadcast in the data) but confirm with the client before launch.

**Outside working hours:** the assistant stays available for product/FAQ questions at all times; only human manager handoff is time-gated. When escalating outside working hours, use the client-specified line in the customer's own language — see `prompts/system_prompt.md`'s escalation section for the exact wording in each of the three languages; it is not an English-only line.

## Certifications

- ISO certification: held. `[NEEDS CLIENT CONFIRMATION of exact standard/number.]`
- Sanitary-epidemiological conclusion (СЭС): held. `[NEEDS CLIENT CONFIRMATION of exact document reference.]`
- Halal certification: **not held**, confirmed multiple times directly. The assistant must never imply Halal certification exists.

See [`certificates.md`](certificates.md) for how to handle certificate requests.

## Loyalty programs

- Retail: UDS app-based loyalty/points program exists.
- Wholesale/B2B: no bonus or loyalty program exists (confirmed directly — asked and declined once in the data).

## Company facts NOT to state without escalation

- Exact legal entity name/registration details — always escalate legal/contract questions.
- Bank account details, current card numbers — these changed multiple times in the historical data and must come from the manager at time of payment, never hardcoded into the assistant.
