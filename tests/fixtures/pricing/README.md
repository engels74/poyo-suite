# Reviewed public pricing corpus

`public-pricing.html` is a fixed, sanitized representation of the public Next.js `models` data
served by <https://poyo.ai/pricing>. The capture provenance, source-content hash, review version,
normalized-inventory hash, and exact row counts are recorded in `reviewed-inventory.json`.

Only fields needed for pricing normalization are retained: image/video category, public model ID,
credits, displayed USD price, unit, and billing dimensions. Descriptions, comparison text, page
markup, scripts, and unrelated categories are omitted. Normal tests use this local corpus and never
contact Poyo.

The reviewed capture contains 209 image/video rows: 76 allowlisted pricing tiers and 133 rows with
an explicit unsupported reason. `supported-signatures.json` provides one deterministic calculation
vector per allowlisted signature; `unsupported-rows.json` preserves the ordered unsupported result.
Tests assert the exact counts and normalized-inventory hash so omissions require an explicit corpus
review/version change.

Published `credits` are authoritative. `priceUSD * 200` is checked only as a consistency diagnostic
and is not a billing formula. `per second` rows estimate `credits * duration * quantity`; `per
generation`, `per image`, and `per video` rows estimate `credits * output quantity`. Values remain
estimates, not billing guarantees.

The public page can change without notice. Rows that cannot be uniquely matched to the current
registry remain unavailable at runtime. In particular, a model may publish complementary units
(for example, both per-input-image and per-second rows); individual signatures are reviewed, but a
request with multiple compatible tiers fails closed instead of inventing an additive formula.
