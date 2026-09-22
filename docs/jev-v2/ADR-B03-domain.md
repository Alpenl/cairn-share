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


## 2026-09-22 R3-12: decision references and concurrency

Migration 0021 adds `run_ids`, `run_references_complete`, `expected_personal_revision`, and payload identity version to the decision row. `classification_decision_runs` retains a foreign-key-protected reference to every run, populated in the same insert transaction. A normal classification completion records its singleton; an explicit policy replay records its sorted complete set (1–64 unique positive IDs). Historical decisions only recorded their primary run: migration retains that known singleton with `run_references_complete=false`, without claiming discarded references can be recovered. An older executable can still write its primary-only shape after migration; those rows remain uncertified.

For a new replay, every run must be succeeded/complete and match the current content revision and target generation. All runs must share immutable spec, actual resolved model, source identity and bounded wire identity. Different request aliases can be compatible when the recorded concrete model is the same; a shared alias does not make different resolved models compatible. A legacy singleton with unknown source metadata can still be re-decided, but multiple unknown input identities cannot be certified as one input. Every claimed snapshot must belong to the same bookmark and match that run's revision and source hash.

The final transaction checks the personal revision, content revision, target and **every** referenced run, using bounded JSON membership instead of one SQL placeholder per field per run. Failed guards insert neither the decision nor its references. An explicit `expected_revision` mismatch reports `revision_conflict`; a race against the implicitly captured revision is also rejected. The immutable operation hash binds the supplied spec/hash/models/content/CAS fields, run set, policy and automatic result. Identical successful operations are confirmed before checking mutable current state, including after later human edits or source/target changes. Changed logical payloads conflict. Historical version-0 receipts retain their old hash semantics and report unknown historical revision/reference completeness.

GET decisions returns the complete known `run_ids` and its completeness flag alongside the compatibility `run_id`. A replay acknowledgement identifies the stored decision and its accepted revision; its `effective` field is the current human-resolved view, not a fabricated historical UI snapshot. Exact concurrent submissions create one decision. No model run or source record is created by a pure policy replay.

Cache rebuilding pins personal revision, content revision and latest decision ID for all projection writes. A superseded computation cannot overwrite a newer cache; a missed guard re-reads current state with at most three attempts. The automatic input used for v1 projection comes from the same computation as the effective view. References prevent retention from deleting a secondary input run; deleting the bookmark cascades its decisions and references along with the existing private history.


## 2026-09-22 R3-06: owned evidence execution

Migration 0022 keeps historical requests at protocol 0 and adds an opt-in protocol 1. A new intent binds the bookmark, exact archived snapshot/revision/hash, target generation, stored external URL and immutable byte/time budget. An identical dedupe key confirms the same intent; changed identity conflicts. Protocol 0 remains metadata-only and cannot be claimed by the new execution API or silently imported into its recovery queue.

`POST /api/v2/evidence-requests/:id/claim` reserves one owner token with a 120-second lease; retries with that same token confirm the existing claim. Other consumers get `owned=false` and never receive the owner's token. At most two attempts may be reserved for an intent; an expired second attempt becomes terminal. Neither a replay nor process restart resets this budget. Fetch requests are limited to 2 MiB and 30 seconds; consumers may lower these bounds and continue enforcing their configured allowlist and network policy.

`checkpoint` stores the owner's bounded outcome with a payload hash before source mutation. Exact checkpoint repeats are idempotent, changed payloads or late/foreign owners conflict. `finalize` uses the saved outcome, preserves existing objective blocks and appends an explicitly identified external-article block. Objective archives deliberately exclude fetched_at; replay does not invent a fetch timestamp. One D1 transaction marks application ownership, inserts the new snapshot, advances content revision, re-arms classification and stores a durable receipt. A failed transaction retains its checkpoint and cannot partially change the source or queue. A competing active classification defers application; stale input/target rejects it; identical archived material is a no-op. Repeated finalize confirms the same receipt and cannot re-arm twice. Snapshot capacity failures become explicit terminal blocked outcomes, retaining the old archive.

`GET /api/v2/evidence-requests/recoverable?limit=N` returns at most 20 new, expired-owned or checkpointed intents to the enabled processor. A fresh processor can finalize saved outcomes without another external request, even with no classification job pending. Before a checkpoint exists, a process can die after its HTTP request has succeeded: exactly-once external I/O cannot be promised across that boundary. Recovery may use the remaining reserved attempt, bounded by the immutable two-attempt limit. After the checkpoint, source application and requeue recovery require zero further fetches.

Default extension flags remain off. New execution requests require the internal token and URLs already present in the stored source; arbitrary model-proposed URLs cannot create an owned request. Existing primary source text, human curation and reading results are retained. Request/checkpoint/receipt data are private bookmark history and cascade on bookmark deletion. This protocol proves owned execution and recovery; it does not by itself certify the full B09 quality, throughput or global budget acceptance matrix.
