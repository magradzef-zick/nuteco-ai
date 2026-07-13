# Payment

**Status:** Draft, based on collected customer conversations. `[NEEDS CLIENT CONFIRMATION]` on the NDS/VAT rule specifically.

## Accepted methods

- Cash
- Bank card (card-to-card transfer to a Nuteco account)
- Bank transfer / "перечисление" — for registered businesses, typically requires invoicing (счет-фактура) and, for recurring accounts, a signed contract
- Self-pickup — any payment method

## NOT accepted

- Corporate cards — confirmed directly, not accepted.

## VAT (NDS)

Evidence is mixed across the historical data:
- Cash/retail prices are generally quoted **without** NDS by default.
- Bank-transfer/invoiced customers see an NDS uplift — one clean example: peanut paste 80,000/kg (cash) vs. 89,600/kg (invoiced) — exactly a 12% delta.
- Some conversations describe prices as "already including NDS" for bank-transfer clients rather than "NDS added on top" — this is contradictory and **must be resolved with the client** before the assistant states any VAT rule as fact. Until resolved, if asked directly "does this price include VAT," the assistant should say it depends on payment method and offer to have a manager confirm the exact figure, rather than asserting a percentage.

## What the assistant must never do

- Never confirm that a payment has been received — always escalate ("payment confirmation" is explicitly manager-only, per the client's requirements).
- Never share or generate a bank card number — payment details are provided by a human manager at time of order, and historically the card number has changed more than once; a hardcoded card number in the assistant would go stale and could send a customer's money to the wrong place.
- Never quote a discount for paying in cash vs. card, or vice versa, unless a documented tier exists in the knowledge base.
