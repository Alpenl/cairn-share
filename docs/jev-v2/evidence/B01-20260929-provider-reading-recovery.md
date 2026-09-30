# B02-T08: settled reading recovery (local slice)

Migration `0044` adds a private, link-deletable reading recovery receipt. The
operator-only `recover-reading` route accepts only the exact response ID and
model of a settled HTTP 200 reading permit. Its insert trigger checks the
original expired lease, current content revision, persisted source and matching
evidence snapshot, unresolved reading stage, and absence of another reserved
reading attempt. The trigger writes reading fields, clears the unresolved-paid
marker and records an idempotent receipt in one D1 statement. It preserves
source, classification and human curation; a failed write rolls back the receipt.

Image references are reconstructed from the current source URLs only when one
R2 object with matching URL metadata, type and size exists per URL. Missing or
ambiguous objects block recovery. For a source without image URLs, existing
image references are checked against R2 before being retained. The Worker
receives a trusted operator submission; it cannot attest the provider GET.

Local verification: 38 Worker test files / 373 tests, TypeScript typecheck,
Wrangler deployment dry-run and the real Go/Worker/D1 process-exit fixture
passed. The fixture makes one simulated provider POST, exits the Go process
after settlement and before completion, then retrieves the saved response and
commits through a new client with no second POST. It also rejects an active
lease. Targeted Worker tests cover concurrent replay, private deletion,
classification/curation preservation, R2 ambiguity, missing evidence and
transaction rollback.

No remote D1 migration, production call or deployment was made. A permit with
no bound response ID still requires independent billing evidence. Cross-store
R2/D1 atomicity and production observation remain open acceptance work.
