# Custom dimensions

Migration 0067 is additive. It preserves existing custom tag IDs, old clients and all pre-existing table columns. Existing custom memberships remain human-owned. The UI service negotiates collection protocol 2 using the existing internal API, with credentials kept server-side.

`POST /api/v2/tag-catalog/operations` additionally accepts `dimension_create`, `dimension_edit`, `dimension_archive`, and `dimension_restore`. Each operation carries a UUID `operation_key`, a stable dimension `id`, and `expected_revision`. Create/edit definitions accept `label`, `description`, `color` (0–7), and `ai_enabled`. Catalog reads expose `dimensions` separately from the fixed taxonomy. Presentation overrides may use built-in dimension IDs; custom dimension identities use UUIDs.

Custom tag create/PATCH additionally accepts `dimension_id`, `description`, `aliases`, and `ai_enabled`. Old clients omitting these fields preserve them. AI requires a dimension and a nonempty definition. PATCH `archived` preserves relationships; DELETE with `detach_all:true` archives the definition and removes relationships. Restore keeps the same ID.

The scheduled custom classifier is enabled by `CAIRN_CUSTOM_TAG_AI_ENABLED=1` plus the encrypted `TYPESAFE_API_KEY` binding. It uses the pinned Jev 1.13 model, bounded Noul batches, and the existing shared extension budget (20 daily calls, 2 per item; unchanged ceilings). Only archived original text is supplied; no retrieval is performed. Inputs over the current 24,000-character/60,000-byte request limits wait for manual classification. The 0.85 application threshold is a conservative policy, not a measured accuracy claim.

Persistent leases prevent concurrent duplicate provider calls. An ambiguous provider failure remains charged and is not retried in the same UTC day. Changing a definition invalidates its cached judgment. Content/definition checks and durable human overrides protect in-flight results. Human attach/detach from either frontend takes precedence; undo restores prior custom override/origin state. Confirmed-only collection rules exclude AI custom associations.

Tests use a local D1 database and mocked provider responses; no paid calls or synthetic production writes are part of validation. Rollback keeps 0067 and its data. Disable the custom AI flag to stop new work, and revert code/UI versions without restoring an old full database over subsequent user writes.
