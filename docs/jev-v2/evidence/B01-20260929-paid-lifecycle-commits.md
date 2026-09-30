# OBS-02: paid lifecycle and commit events (local slice)

The Worker now records fixed events for the remaining source/reading payment
transitions and their business commits:

- Fallback authorization reports a first authorization or an identical
  replay. The guarded UPDATE changes the row once; a replay reads the existing
  state and keeps the prior HTTP response.
- Operator-confirmed nonbilling reports success only after the audit and
  pending-queue transition commit together. A matching private audit receipt
  reports replay.
- Each successful source checkpoint reports `stored` after its D1 batch. This
  is a checkpoint event, not a unique logical job completion count; the
  checkpoint API has no operation receipt.
- Reading completion reports `committed` after its receipt and link update
  commit, `replay` for a pre-existing matching receipt, and
  `receipt_confirmed` when an interrupted write is followed by an exact
  receipt read. Invalid or conflicting requests report rejection; a thrown
  transaction reports failure without a success event.

All events use the existing off/basic/diagnostic switch and bounded
per-isolate export/drop counter. Only fixed stage, outcome, status and config
version fields reach platform logs. Link IDs, operation keys, actor, evidence
reference, lease, source, translated text and model output remain private.
The D1 attempt ledger and receipts, rather than log delivery, establish
whether a transition committed. Supplier billing still needs independent
evidence.

Local verification: 38 Worker test files / 383 tests, TypeScript typecheck
and Wrangler deployment dry-run passed. Tests cover first/replayed fallback
authorization and nonbilling, source checkpoint success/rejection, reading
completion commit/replay/conflict, transaction rollback, private fields and
the runtime off switch. No remote migration, deployment or paid call occurred.

OBS-02 still needs Go-side pre-send/response events, trace propagation and a
private deletable correlation store, fixed-query D1 cost coverage, collector
failure tests, same-load overhead and production observation.
