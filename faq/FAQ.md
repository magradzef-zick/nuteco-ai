# Nuteco Premium — FAQ

Every answer below is either directly confirmed by Nuteco staff, or explicitly marked **[NEEDS CLIENT CONFIRMATION]** where the source data was inconsistent. Prices shown must be re-verified against the client's current price list periodically — prices drift over time and the assistant must never serve a stale number as current fact.

This file is written for a human to review and correct. The production knowledge base is the per-topic files in [`../knowledge/`](../knowledge/) — this FAQ is a readable front-end onto the same facts, organized the way the client asked for it.

> **Authoritative-source rule:** this file is **not** injected into the assistant's context and is **not** read by the running system. It exists purely for humans to review in one readable place. `../knowledge/*.md` is the single machine-fed source of truth. **If you update a fact, update it in the matching `knowledge/*.md` file — editing only this file will NOT change what the assistant says.**

---

## Products

**Q: What products do you make?**
A: Nut butters (pastes) and nut flours from almond, pistachio, hazelnut, cashew, peanut, and walnut, plus sesame (tahini) paste, chia seeds, and psyllium. Praline (walnut, pistachio) exists as a limited/made-to-order line; marzipan is in active development/sampling as of mid-2026. **[NEEDS CLIENT CONFIRMATION on current praline/marzipan availability — this changed multiple times in the historical data, see Knowledge Gaps §7.]**

**Q: Do you sell whole/raw nuts, not just paste or flour?**
A: No. Confirmed repeatedly and consistently: "We're not a shop, we're a production workshop" — only pastes and flours are sold.

**Q: What's the difference between regular almond flour and Keto almond flour?**
A: Keto almond flour is made from unblanched almonds (skin on) — higher fiber, more retained vitamins, more aromatic. It's used the same way as regular almond flour (baking, breading) plus specifically for keto baking. Regular ("white") almond flour is made from blanched (peeled) almonds.

**Q: What is your "ореховая паста" (nut-mix paste) made of?**
A: Almond, peanut, honey, seeds, cinnamon.

**Q: Do you have a peanut paste without honey?**
A: Yes — both honey and no-honey versions exist for peanut paste; the manager always confirms which variant before finalizing an order.

**Q: Does walnut paste come without honey?**
A: No — historically walnut paste was only offered with honey. **[NEEDS CLIENT CONFIRMATION — verify still current.]**

## Ingredients & Composition

**Q: Are your pastes made with any additives, thickeners, or emulsifiers?**
A: No — confirmed explicitly for peanut paste ("just ground peanut and nothing else — no thickeners, emulsifiers, or other 'chemistry'"). Composition questions for other products should be answered from the per-product [`../knowledge/products.md`](../knowledge/products.md) file where documented.

**Q: What honey do you use?**
A: Natural flower honey, described by staff as a certified product.

**Q: Is your product safe if I have a nut allergy — is it produced separately from other nuts?**
A: **Escalate to a manager — do not answer.** This touches food-safety/allergen guarantees that are not documented with any lab or certification reference in the source data. Never repeat an informal reassurance as a guarantee.

**Q: Do you hold Halal certification?**
A: No. Nuteco holds ISO certification and a sanitary-epidemiological (СЭС) conclusion, but not a Halal certificate. **[NEEDS CLIENT CONFIRMATION of exact certificate names/numbers before quoting this to end customers.]**

**Q: What's the shelf life of your pastes and flours?**
A: Pastes: 4 months (natural product, no preservatives). Flours: 6 months. Refrigeration is recommended for pastes.

**Q: Can pistachio paste be added to ganache / desserts / coffee / savory dishes?**
A: Yes — it's commonly used as an ingredient in desserts, ice cream, baking, cakes, coffee, and as an addition to sauces for meat/seafood or salad dressings.

**Q: What is psyllium and how is it used?**
A: Psyllium absorbs a large amount of water and forms a gel-like mass; used in vegan baking as an egg substitute (1 part psyllium + 3 parts water ≈ 1 egg). Botanically, it's plantain seed husk.

**Q: Why was my pistachio paste runnier/thicker than last time?**
A: Normal batch variation — pistachio paste's consistency depends on the fat content of the pistachios and the grind level; it's expected to vary slightly and isn't a defect. If the customer isn't satisfied, treat as a quality concern and escalate rather than only reassuring.

## Pricing

*(Prices and sizes are not in this file and not in `products.md`. The client's official price list is [`../knowledge/prices.md`](../knowledge/prices.md) — edit that one file to change every price the assistant quotes.)*

**Q: How is pricing shown — does it include tax?**
A: Prices are generally quoted without VAT (NDS) by default unless the customer is on invoiced/bank-transfer terms, in which case a NDS uplift (observed as 12% in at least one clean example) applies. **[NEEDS CLIENT CONFIRMATION — this was stated inconsistently across the corpus, see Knowledge Gaps §3.]**

**Q: Do you offer discounts for regular customers or larger orders?**
A: There is a retail loyalty program (UDS app). No confirmed general discount schedule exists beyond that — bulk-pricing requests are handled case-by-case and typically need management approval. **The assistant must never state a discount percentage or invent a tier; escalate.**

**Q: Do you have a bonus/loyalty program for wholesale/B2B customers?**
A: No — confirmed directly; only the retail UDS program exists.

## Delivery

**Q: Do you deliver, and how?**
A: Yes. Payment by card routes through Yandex delivery; cash payment routes through Nuteco's own driver or Millennium Taxi. Customers can also arrange their own courier/Yandex pickup. Regional deliveries (outside Tashkent) go via BTS post.

**Q: Is delivery free?**
A: For wholesale/bulk orders, delivery is free from 5kg. **[NEEDS CLIENT CONFIRMATION whether an equivalent retail free-delivery threshold exists — not confirmed in the data.]**

**Q: How much does delivery cost?**
A: Cannot be quoted with certainty — real delivery fees vary (observed 25,000–82,000+ sum) based on live courier pricing and distance; the assistant should say the exact fee will be confirmed at dispatch rather than quoting a number.

**Q: How fast is delivery?**
A: Same-day/next-1-3-days within Tashkent depending on order timing (orders must typically be placed before the day's dispatch cutoff, historically ~17:00–17:30); 1-3 days for other regions of Uzbekistan via BTS post. **[NEEDS CLIENT CONFIRMATION of exact current cutoff time.]**

## Payment

**Q: What payment methods do you accept?**
A: Cash, bank card, bank transfer (for registered businesses), and self-pickup (no payment-method restriction for pickup).

**Q: Can I pay with a corporate card?**
A: No — confirmed directly, corporate cards are not accepted; only cash, bank transfer, or personal card-to-card transfer.

**Q: I already paid — can you confirm you received it?**
A: **Escalate — never confirm payment receipt as the assistant.**

## Orders & Working Hours

**Q: What are your working hours?**
A: Monday–Friday 10:00–18:00; wholesale order/delivery cutoff around 17:30. Closed Saturday and Sunday. **[NEEDS CLIENT CONFIRMATION — stated inconsistently across the source data; use the most recent broadcast as the working assumption.]**

**Q: I'm messaging outside working hours / on a weekend — will anyone answer?**
A: The assistant remains available 24/7 for product/FAQ questions; human manager handoff happens during the next working period. Use the client-specified line verbatim: "The manager will contact you during the next working period."

**Q: Can I change my order after placing it?**
A: **Escalate — order modifications are always handled by a manager, not the assistant.**

**Q: Can I return a product / get a refund?**
A: **Escalate — no documented self-service return policy exists; a manager will advise.**

## Wholesale / Corporate / B2B

**Q: I want to order in bulk / I run a business — can I get wholesale pricing and invoicing?**
A: **Escalate immediately to a manager.** Wholesale, corporate, and any bank-transfer/invoiced order is handled directly by the Nuteco team, not the assistant.

**Q: Can you send me your certificates for my marketplace listing / my own customers?**
A: **Escalate** — document requests are handled by a manager (only ISO and СЭС certificates are confirmed to exist; never promise a Halal certificate).

## Other Retail Locations

**Q: Where else can I buy your products besides ordering directly?**
A: Historically, staff have named a few retail partners (Matcha, Organicfood, Экобазар, Zefir) as also carrying Nuteco products, with Nuteco's own workshop having the largest range/volume. **[NEEDS CLIENT CONFIRMATION this list is current before the assistant repeats it.]**
