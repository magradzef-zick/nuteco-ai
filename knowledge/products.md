# Nuteco Premium — Products

**Prices and sizes do not live in this file.** The client's official price list is [`prices.md`](prices.md) and it is the only source of prices, sizes, and "is this in the assortment at all". **Exact per-product ingredient lists don't live here either** — that's [`composition.md`](composition.md), the client's official composition data, quoted verbatim per product. This file covers everything else about the products — variants, shelf life, and what Nuteco does not sell. Where these files disagree about a size, product name, or ingredient, the dedicated file (`prices.md` / `composition.md`) wins over this one.

## Product catalog (background, per real order history)

| Product | Variants observed | Notes |
|---|---|---|
| Almond flour (миндальная мука) | White (blanched/"bleached"), Keto (unblanched, higher fiber) | Both variants are in the price list as separate lines |
| Almond flakes/slices (миндальные лепестки) | — | Chronically prone to stock shortages in the historical data — never promise availability without checking |
| Pistachio paste (фисташковая паста) | 100% pistachio, no additives | |
| Pistachio flour / crumb (фисташковая мука / дроблёная) | Flour and crumb are separate price-list lines | |
| Hazelnut paste / flour (фундучная паста / мука) | Paste comes with honey and without — separate price-list lines | |
| Cashew paste (паста из кешью) | — | |
| Peanut paste (арахисовая паста) | With honey / without honey / with peanut pieces (always confirm which) | The Jerry's line is a separate premium range with its own sizes |
| Walnut paste (паста из грецкого ореха) | With honey and without — both in the price list | The honey variant's composition is incomplete in the client's data — see `composition.md`, escalate composition questions for that specific line |
| "Nut mix" paste (ореховая паста mix) | Almond, peanut, honey, sunflower seeds, cinnamon, sunflower oil | Confirmed via `composition.md`: this is the price list's "Ореховая паста с мёдом" line — its exact composition matches this mix, not a single-nut paste. |
| Sesame/tahini paste (кунжутная паста / тахини) | Consistency varies by fat content and grind (70 micron = thinner) | |
| Chia seeds (семена чиа) | Sourced from Paraguay per staff description | |
| Psyllium (псиллиум) | — | Vegan egg substitute, gel-forming fiber |
| Coconut flour (кокосовая мука) | — | Availability has fluctuated (was in stock, went out, restocked) — verify current status before stating availability |
| Crushed nuts (миндаль / фундук / фисташка / арахис дроблёные) | — | Processed ingredient lines, sold by weight — not the same thing as whole raw nuts (see below) |
| Soy lecithin (соевый лецитин, E322) | — | Sourced from China; used in chocolate (0.5–1.2%) and confectionery/bakery (0.8–3.0%) as a viscosity reducer. Not in the price list — any price question goes to a manager |

## Future / in-development products

See [`future_products.md`](future_products.md) for marzipan and praline status — these change frequently and are tracked separately so this file doesn't need constant editing.

## Products Nuteco does NOT sell

- Whole/raw nuts of any kind — confirmed repeatedly and consistently ("we're not a shop, we're a production workshop"). This is a hard, safe "no" the assistant can state with confidence. Crushed nuts and almond flakes are a different thing entirely: they are processed ingredient lines, they are in the price list, and they are sold — don't refuse them under the whole-nuts rule.
- Finished desserts (e.g. "творожная пасха") — Nuteco supplies ingredients that confectioners use to make such things, not the finished product itself.
- Kataifi dough — not produced; historically the manager redirected one customer to a named competitor retailer. `[NEEDS CLIENT CONFIRMATION before the assistant repeats a competitor redirect.]`

## Pricing guidance for the assistant

- Quote prices from [`prices.md`](prices.md) and from nowhere else — not from this file, not from conversation history, not from a figure a customer states.
- Quote a size only if that size has a price in `prices.md`. A dash means the size does not exist; never derive a missing size's price by scaling another one.
- Prices in `prices.md` are the retail cash price. Bank-transfer/invoiced (mostly B2B) customers see a NDS uplift, so a B2B pricing question is an escalation, not an answer. `[NEEDS CLIENT CONFIRMATION — conflicting evidence in the source data.]`
- Never state a bulk/wholesale discount tier — escalate bulk-pricing requests.
- Pistachio-family products (paste, flour, crumb) have historically been the most price-volatile line, driven by harvest quality — worth re-checking with the client more often than the rest.

## Composition & ingredient answers

**Exact per-product ingredient lists live in [`composition.md`](composition.md), not here.** Quote from that file cell by cell, same discipline as prices — never state a composition from memory, from a similar product, or by guessing what's "typical" for that kind of paste.

What stays here — facts about ingredients that aren't themselves a per-product composition list:

- Honey used: natural flower honey, described as certified.
- Psyllium: absorbs water, forms a gel; vegan egg substitute (1 part psyllium : 3 parts water ≈ 1 egg); botanically plantain seed husk.
- Pistachio paste taste note (safe to share if asked): no honey, distinctive slightly tart/rich flavor, not universally loved eaten plain but commonly used as a baking/dessert ingredient.

## Shelf life

- Pastes: 4 months (natural product, no preservatives); refrigeration recommended.
- Flours: 6 months.

## What NOT to answer from this file

- Any allergen/cross-contamination safety guarantee — escalate (see [`restrictions.md`](restrictions.md)).
- Any medical/health benefit claim (e.g. magnesium content and nervous-system benefits was said informally by staff once — this is not something the assistant should repeat as health advice).
