# ADR: Jev v2 replayable domain model (B03)

Status: implemented (worker), awaiting cross-repo review.
Context: [E #10](https://github.com/Alpenl/cairn-x-enricher/issues/10), [S #29](https://github.com/Alpenl/cairn-share/issues/29).

## Decision

The Worker keeps the existing `links` columns as the **v1 projection** and adds an
append-only v2 history in `migrations/0011_replayable_domain.sql`:

| Table | Role |
|---|---|
| `evidence_snapshots` | recovery-grade objective input keyed by `content_revision` |
| `question_specs` | immutable specification; one `spec_id` ⇔ one `spec_hash` |
| `classification_runs` | append-only evaluation record (answers, usage, model, coverage) |
| `curation_overrides` | field-level human accept/reject/set-empty/reset events |
| `curation_events` | audit of every human action, including why/status edits |
| `current_projections` | query-oriented effective view, rebuilt from the above |
| `entity_states` | per-link entity lifecycle for B09 |
| `budget_ledger` | bounded per-item and batch budget accounting |

`links` gains `content_revision` (objective) and `personal_revision` (note/why/status),
so the two invalidation scopes are physically separate.

## Rationale

- **Replay without inference.** `classification_runs` stores the typed answers and
  their distributions, so changing a threshold or display rule appends a new decision
  over the same run. Replaying never calls the model.
- **Human overrides are events, not a blob.** `accept`/`reject`/`set_empty`/`reset`
  are distinguishable. `reset` removes the override from scope; `reject` is applied
  after the automatic value, so it survives a policy replay. `set []` is an explicit
  empty and is not the same as no decision.
- **Content and personal revisions are separate.** A note edit bumps
  `personal_revision` only; the objective content hash is unchanged, so reading and
  classification snapshots stay valid.
- **Idempotent by operation key.** Run submission and override application both
  dedupe on `operation_key`: a lost response replays the stored result and a
  different payload under the same key is a conflict.
- **CAS on human edits.** Overrides accept `expected_revision`; a stale client
  receives `409 revision_conflict` with the current revision instead of silently
  overwriting a newer decision.
- **Legacy is explicit.** Rows imported from v1 curation are recorded with
  `source='legacy_unknown'` and `confirmed=0`; they are usable but are not promoted
  to reliable gold.

## Canonicalisation

`domain.ts::canonicalJSON` sorts object keys and preserves array order (block order
is semantic). Go and TS will be checked against the same golden vectors; the TS side
is implemented here and the vectors are asserted in `test/domain.test.ts`.

## Rejected alternatives

- **Hash-only snapshots.** They cannot reconstruct the evaluated input, so a
  threshold change could not be replayed honestly.
- **Mutating `links.classification` in place.** It loses the history needed to audit
  a decision and cannot express reject-vs-empty.
- **A v2-only table without a v1 projection.** Old apps and the strict Go decoder
  must keep reading the six legacy fields, so the v1 columns remain.

## Consequences

- Migration is additive; `0009` is unchanged.
- Deleting a link cascades through every domain table.
- `current_projections` is derived and may be rebuilt at any time.
