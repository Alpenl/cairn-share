# S3 batch effective query: request-level observability

The internal `POST /api/v2/links/effective-batch` request now reports its
effective-view SQL result through the existing switchable Worker request log.
The log uses a fixed route and query name and carries `sql_count=1`,
`rows_read`, `rows_written`, response bytes, and total request duration.
`Server-Timing: db` measures only the D1 call, excluding the subsequent
JavaScript folding. The response keeps
the same scoped D1 statistics and export payload. No second SQL query is
performed to obtain the statistics.

The scope is `effective_view_only`: the reported rows and SQL count exclude
observability-policy refresh and any other control query. They therefore must
not be used as the full-request D1 total in the S3 or OBS-04 acceptance report.
When application logs are off, the batch response and `Server-Timing` remain
available but no application request event is emitted. The platform's own
logging switch is separate.

Validation on this branch: 36 Worker test files, 365 tests passed; TypeScript
typecheck and Wrangler deploy dry-run passed. The new request-path test checks
basic-mode log fields, exact response-byte count, `Server-Timing: db`, and
off-mode silence. This is local evidence only. Worker memory, complete
per-request SQL coverage, 2,000/10,000-link workloads, and same-load p95/p99
remain open under Share #30, Enricher #20 and #16. No deployment or paid model
call was made.
