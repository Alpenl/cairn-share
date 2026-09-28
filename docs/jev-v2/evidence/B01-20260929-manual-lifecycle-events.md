# OBS-02: manual entry and source claim events (local slice)

The Worker now emits fixed `manual_request` events for manual source and
manual-process requests. An `accepted` event is recorded only after the D1
batch has committed the source/evidence or request receipt. Reusing the same
operation reports `replay`; a rejected request reports `rejected` with its HTTP
status. A thrown route failure reports `failed`. Successful scheduled and
by-ID source claims emit `source_claim` after their guarded D1 update returns
the claimed row. Empty claim polls do not emit lifecycle events.

These events use the existing off/basic/diagnostic hot switch and bounded
per-isolate export/drop counter. They contain only fixed action, origin,
outcome, status and config version fields. Link IDs, operation keys, lease
tokens, source text and URLs stay out of platform logs. D1 operation receipts
and leases remain authoritative; missing logs cannot prove that a request did
not commit or that a supplier was not called.

Local verification: 38 Worker test files / 378 tests, TypeScript typecheck and
Wrangler deploy dry-run passed. Targeted tests check accepted versus replay,
409 and 429 rejection, scheduled and by-ID claims, absence of private fields
and the live off switch. No remote migration or deployment was made.

This does not complete OBS-02. Specific rejection reason categories, source
refresh/paid-stage/completion events, private deletable trace correlation,
collector failure tests and same-load overhead measurements remain open.
