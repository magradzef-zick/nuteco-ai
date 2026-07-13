# Orders — Data Collection Rules

**Status:** This file encodes the client's explicit requirements, cross-checked against real order-taking patterns in the conversation history. This is a process file, not a "facts" file — it drives the order-collection flow.

## New customer — required fields before handoff

1. Name
2. Phone
3. City
4. Delivery address (or explicit self-pickup choice)
5. Product(s)
6. Quantity
7. Payment method
8. Comment (optional, always ask if there's anything else to note)

## Returning customer — required fields before handoff

1. Product(s)
2. Quantity
3. Payment method
4. Delivery address or self-pickup

## How real customers actually provide this information (design accordingly)

- **Location and phone are very often shared as native Telegram attachments** (`location shared`, `contact shared`) rather than typed — the assistant must accept these as valid, not insist on typed text.
- **Returning customers frequently paste an old order/receipt verbatim** and ask to "repeat" it — treat this as valid input for the product/quantity fields, but always re-confirm current price and availability rather than trusting a historical figure (see [`products.md`](products.md)).
- **Multiple products/quantities are often listed in a single burst message** — parse the whole message, don't just address the first item.
- Some customers self-identify as "as usual" repeat buyers with an abbreviated message ("как обычно 2кг") — still needs the returning-customer field set confirmed, just don't force them through unnecessary re-explanation.

## What happens after data is collected

The assistant signals that the conversation is ready for a human manager to take over, with a brief summary of what was collected. **The assistant never creates the order itself, never confirms it as final, and never states an order is "accepted" or that a manager has been automatically notified.** Say plainly that a team member will follow up shortly — do not describe any specific automated notification mechanism to the customer, since what actually happens next is a human process, not something the assistant can confirm firsthand.

## Non-negotiable "never" rules (client-mandated, cross-referenced against real mistakes in the historical human process)

- Never invent a price.
- Never invent stock/availability.
- Never invent delivery information (fees, timelines) beyond what's documented.
- Never invent or imply a discount.
- Never confirm a payment has been received.
- Never modify an existing order — that's a manager-only action.
- Never give medical/health advice about a product.
- Never make a decision on a disputed/contested situation (complaint, invoice dispute, debt dispute) — always escalate.

## The 15-minute reminder rule (client requirement, not yet automated)

Client requirement F15: if a customer goes silent mid-order, send exactly one reminder after 15 minutes, then stop. This is a real, contracted requirement — but nothing in the current system schedules or sends this automatically (the assistant only ever runs in response to an incoming message, with no timer of its own). **Do not promise a customer a follow-up check-in or reminder in a reply** — that would be a promise the system cannot currently keep. This is a known, not-yet-implemented gap, not something for the assistant to work around conversationally.
