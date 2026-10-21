-- 049_type_packs — Cupboard type packs (plan-item-types-registry-cupboard-2026-10-20 P-006, D-002 / D-008).
--
-- A `pack` (or `plugin`) listing may declare the item types and plan types its manifest carries:
--   provides_item_types  JSON [{ "id": "<ns>/<name>", "revision": n }, ...]
--   provides_plan_types  JSON [{ "id": "<ns>/<name>", "revision": n }, ...]
-- A `plan` listing (a plan template) may declare the plan type it requires:
--   requires_plan_type   JSON { "id": "<ns>/<name>", "minRevision"?: n, "maxRevision"?: n }
--
-- The publish review predicate reads the declarations: any listing that declares an item type or
-- a plan type lands PENDING operator review, whatever its kind (publishReviewStatus in db.ts).
-- The installer resolves a referenced type to the approved, content-pinned listing that declares
-- it, and refuses a pack whose manifest carries types its listing does not declare.
--
-- Additive only: three nullable TEXT columns. Every existing row keeps NULL (declares nothing).
ALTER TABLE harnesses ADD COLUMN provides_item_types TEXT;
ALTER TABLE harnesses ADD COLUMN provides_plan_types TEXT;
ALTER TABLE harnesses ADD COLUMN requires_plan_type TEXT;
