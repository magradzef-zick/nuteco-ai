# B2B / Wholesale Detection Signals

**Why this file exists:** B2B detection was originally described only in prose ("company name, bank-transfer language, invoice language") with no enumerated, testable signal list — a real reliability gap on the highest-volume traffic segment (roughly 60% of customer conversations are B2B). This file is the single, versioned source of truth for both the deterministic keyword pre-filter and the LLM's own judgment — both should reference this exact list, not separately-maintained copies.

## Strong signals (any one is sufficient to flag B2B — high precision, low false-positive risk)

- Explicit business/invoicing vocabulary: "перечисление", "счет-фактура", "счёт", "договор", "доверенность", "ИНН", "НДС"/"NDS", "юр.лицо", "реквизиты", "Didox"
- A company/brand name used as the order identity (e.g. "оплата из [Company]", "заказ для [Brand]")
- Explicit statement of reseller/business intent: "у меня магазин", "мы кофейня/кондитерская/пекарня", "оптом", "wholesale", "опт"
- Request for a business document: contract, invoice, акт сверки, business certificate/license

## Medium signals (individually suggestive, escalate on 2+ co-occurring in the same conversation)

- Bulk quantities uncharacteristic of personal use (e.g. 10kg+ of a single product in one message)
- Recurring/scheduled order language ("как обычно", paired with a business-sized quantity)
- Multiple distinct delivery addresses or "branches" mentioned in one thread
- A question about payment terms/credit ("оплата в течение 5 дней", "по факту доставки")

## Explicit signals from the customer stating it directly

- "Можно оптовую цену?" / "у вас есть цены для бизнеса?" / any direct ask for wholesale/corporate pricing — always a strong signal regardless of quantity.

## What this list is NOT for

This list drives **escalation, not classification precision for its own sake.** The cost of a false positive (escalating a large personal order unnecessarily) is low — a human quickly confirms it's retail and moves on. The cost of a false negative (running the full retail order-collection flow on a real wholesale buyer) is high — it produces exactly the "assistant asked for my home delivery address when I'm ordering for my café" experience that reads as broken. **When uncertain, treat it as a signal, not as a reason to withhold escalation.**

## Mid-conversation reclassification (the case the original design missed)

B2B signals often surface a few messages into a conversation that started looking like retail. If a signal from this list appears **after** the assistant has already started collecting retail order fields (name, phone, personal address):

1. Stop collecting further retail fields immediately.
2. Do not discard what's already been collected — include it in the escalation handoff summary (a manager may still want it).
3. Escalate, explicitly noting in the handoff summary that this reclassified mid-conversation, so the manager isn't confused by a retail-shaped partial record attached to a B2B escalation.

## Maintaining this list

If real usage reveals a B2B conversation that wasn't caught (false negative) or a retail conversation escalated unnecessarily and repeatedly on the same false signal, update this file — it's the only place this logic should live. Do not let the deterministic pre-filter and the LLM prompt drift into separately-maintained versions of "what counts as B2B."
