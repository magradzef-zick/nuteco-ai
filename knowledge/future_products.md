# Future / In-Development Products

**Status:** This is the single fastest-changing fact set in the entire knowledge base — treat with extra caution. The client's brief lists four future products: almond marzipan, walnut praline, pistachio praline, hazelnut praline. Real conversation history shows these are not a clean "not yet started" list — they're at genuinely different, evolving stages, and answers given in 2023–2025 conversations were later contradicted by 2026 conversations. `[EVERYTHING IN THIS FILE NEEDS CLIENT CONFIRMATION OF CURRENT STATUS BEFORE LAUNCH.]`

## Marzipan (миндальный марципан)

- Nov 2025: a customer asked if marzipan was available — answer was flatly "no."
- By mid-2026: Nuteco had developed a trial batch and was actively running a feedback campaign with existing B2B confectionery clients ("Мы разработали пробную партию МАРЦИПАНА и хотели бы узнать Ваше профессиональное мнение"), described as 60% almond, 35% powdered sugar, 4% glucose syrup.
- **Current assistant behavior:** do not state marzipan is generally available for retail order unless the client confirms it has moved past B2B sampling. If a customer asks, say the product is in development/limited trial and escalate if they want to actually order it.

## Praline — pistachio and walnut

- 2024: mentioned once as an existing made-to-order SKU with a 5kg minimum order.
- Pricing seen historically: pistachio praline ~392,000/kg with NDS (2023-era figure, do not treat as current).
- **Current assistant behavior:** treat as a real but limited/made-to-order product; confirm current minimum order size and price with the client before quoting; if unsure, escalate.

## Praline — hazelnut

- 2023: explicitly "we don't make it" ("Фундучное пралине не делаем").
- 2026: "Пока скоро запустим пралине из фундука, фисташки и грецкого ореха" (planning to launch soon) — implying an active roadmap for a 3-nut praline line matching the brief.
- **Current assistant behavior:** do not state hazelnut praline is available unless confirmed current; if asked, say it's part of Nuteco's upcoming product roadmap and offer to have a manager follow up.

## Why this file exists separately from `products.md`

Keeping fast-moving, roadmap-stage products in their own file means the client can update just this file frequently (or the assistant can be configured to always escalate anything referencing marzipan/praline) without touching the stable core product catalog.

**Recommended default behavior until the client provides current status:** for any question about marzipan or praline, the assistant should give the general "these are part of our upcoming product line, let me connect you with a manager for current availability and pricing" response rather than attempting to quote a specific price or promise availability.
