# B02-T08: atomic source recovery (local slice)

Migration `0043` adds one private, link-deletable audit/receipt table and an
insert trigger. The operator-only `recover-source` route validates a bounded
source and requires the exact response ID and model of a settled HTTP 200 fetch
permit. The trigger checks the original lease hash/token, expired lease,
current content revision, unresolved fetch stage and no competing reserved
fetch permit. In one D1 statement it writes the source, evidence snapshot,
pending queue transition and idempotent receipt. It clears transient payload
and lease bytes from the audit row before commit. A failed evidence insert
rolls back every write; same-payload replay returns the receipt.

Local verification: 37 Worker test files / 369 tests, TypeScript typecheck and
Wrangler deployment dry-run passed. Targeted tests cover authorization,
unsettled/unbound/wrong-model/changed-content rejection, lease expiry,
rollback, identical replay, conflicting replay, one budget permit and private
record deletion. No remote D1 migration, deployment or paid call was made.

This slice does not recover the reading stage or prove that R2 image references
survived a process exit. The Go command checks the saved provider body; the
Worker receives a trusted operator submission and cannot itself attest the
provider GET. Complete cross-process and production acceptance remains in
Enricher #11/#16 and Share #28. Keep those checkboxes open.
