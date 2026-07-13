# Delivery

**Status:** Draft, based on collected customer conversations. `[NEEDS CLIENT CONFIRMATION]` on exact current fee structure.

## Coverage

Nationwide across Uzbekistan, per the client brief:
- Tashkent: 1–3 days.
- Other regions: 1–3 days, via BTS postal courier.

## How delivery is arranged (by payment method — this is a consistent, well-confirmed pattern)

| Payment method | Delivery channel |
|---|---|
| Bank card | Yandex Delivery (tracking link sent after dispatch) |
| Cash | Nuteco's own driver, or Millennium Taxi |
| Bank transfer (wholesale) | Nuteco's own driver, standard for B2B accounts |
| Self-pickup | Customer picks up directly from the workshop, any payment method |
| Outside Tashkent | BTS postal courier |

## What information the assistant should collect for delivery

Per the client's order-collection requirements: delivery address (or confirmation of self-pickup) and a recipient phone number. In practice, customers very often share this as native Telegram location/contact-card attachments rather than typed text — both are valid, equivalent inputs.

## Delivery cost

**Do not quote an exact delivery fee.** Real historical fees ranged from ~25,000 to 82,000+ sum with no consistent, quotable formula — driven by live courier (Yandex/Uklon) surge pricing and distance. Correct behavior: tell the customer delivery is available and the exact fee will be confirmed at dispatch/by the courier, or state a documented free-delivery threshold if one applies (see below).

**Free delivery:** confirmed for wholesale orders from 5kg. `[NEEDS CLIENT CONFIRMATION whether an equivalent retail threshold exists — not found in the data.]`

## Delivery timing / cutoffs

Same-day dispatch generally requires the order to be placed before a daily cutoff, historically observed around 17:00–17:30 for wholesale. `[NEEDS CLIENT CONFIRMATION of the exact current cutoff — stated inconsistently across the historical data.]` Orders placed after the cutoff, or outside working hours/on weekends, are processed the next working day.

## Known failure modes to design around

- Delivery drop-off location ambiguity at multi-person B2B sites (courier leaves goods with someone who wasn't clearly told) recurred as an unresolved friction point for at least one wholesale account — the assistant should always collect a specific recipient name/phone, not just a general company address.
- "Wrong address dispatched" mistakes happen on the customer's side too (customer sends courier to the wrong location) — if this comes up, escalate rather than trying to redirect a courier itself.
