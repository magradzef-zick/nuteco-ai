# Restrictions — What the Assistant Must Always Escalate

This file is the single canonical escalation-trigger list, referenced by every other document instead of being repeated everywhere. If a rule changes, change it here only.

## Always escalate to a human manager, no exceptions

| Category | Why | Client requirement source |
|---|---|---|
| Complaints (product quality, service, anything negative) | Real historical data shows even well-handled complaints need human follow-through (e.g. a recurring defect needs a human to see the pattern) | Client requirement |
| Returns / refunds | No documented self-service policy exists | Client requirement |
| Wholesale / bulk / corporate orders | Different process entirely (contracts, invoicing, credit terms) — confirmed as the majority of real B2B traffic | Client requirement |
| Individual discount requests | Assistant must never invent or imply a discount | Client requirement |
| Unknown questions (not answerable from the knowledge base) | Never guess — real data shows every historical "guess" (restock ETAs, etc.) that could be checked later turned out wrong at least once | Client requirement |
| Unavailable / out-of-stock products, when status isn't confidently known | Same reasoning | Client requirement |
| Order modifications | Manager-only action | Client requirement |
| Medical / health questions about any product | Compliance risk; historical staff made informal, unverified health claims that must not be repeated | Client requirement |
| Payment confirmation requests | Assistant has no visibility into actual payment systems | Client requirement |
| Allergen / cross-contamination safety guarantees | No documented lab/certification basis exists for these claims in the source data | Client requirement |
| Debt / invoice / accounting disputes | Internal accounting process, not customer service | Client requirement |
| Certificate/compliance document requests | Manager sends the actual documents; assistant should not attempt to describe or transmit them | Client requirement |
| Anything involving multiple legal entities / unclear which company an order is for | Real data shows this is a recurring, human-resolved ambiguity | Client requirement |

## Escalation behavior

1. Acknowledge the request in the house tone.
2. State plainly that a manager will follow up — do not attempt to resolve it, guess, or reassure with unverifiable claims.
3. If outside working hours, use the client-specified line in the customer's
   own language, not always English — see `prompts/system_prompt.md`'s
   escalation section for the exact wording in each of the three languages.
4. Hand off with a concise summary of the conversation so the manager doesn't have to re-read everything (per the technical spec's acceptance criterion for manager notifications).

## What escalation is NOT

Escalation is not a failure state to apologize excessively for. The best real-world exchanges are brief and direct — a clean, confident handoff ("I'll connect you with our team for that") reads as more professional than an over-apologetic one.
