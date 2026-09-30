# S3 effective batch: 2,000/10,000-link local workload

## Fixture and scope

`worker/test/effective-batch-scale.test.ts` creates libraries of 2,000 and
10,000 links, then reads the last 500 links through ten consecutive 50-ID
Worker HTTP requests. At each size it runs once with no history/body, then
with 20 human override rows and an 8 KiB stored article body per exported
link. For the 20-history cases it also reads the same 500 views through the
old single-ID Worker HTTP route in groups of four, matching Go's former
concurrency. Every old view must equal its batched counterpart. A D1 binding
proxy counts every `prepare` on these requests, including the
observability-policy refresh. The test checks all 500 IDs, bounded response
size, zero writes, and absence of the stored article body.
No paid model call or remote D1 migration is involved.

The figures below are one local Workerd/D1 run. `effective_rows_read` is the
sum of D1 metadata for the ten effective-view queries. The production policy
read uses `.first()` and has no returned D1 meta, so its rows are **not**
included in that number. The separate `policy_sql` count makes this gap
visible. A fixture-only `EXPLAIN QUERY PLAN` verifies an integer-primary-key
lookup on the singleton policy row; the identical SELECT with `.all()`
reported one row read. This bounds the missing control lookup in this fixture
without adding a query to production requests.

| Library links | History/link | Body/link | Batch / old view SQL | Policy SQL | Batch rows read | Batch response | Batch elapsed | Old 500-request elapsed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 0 | 0 | 10 / — | 1 | 2,000 | 179,240 B | 59 ms | — |
| 2,000 | 20 | 8 KiB | 10 / 500 | 1 each | 12,499 | 179,750 B | 73 ms | 2,227 ms |
| 10,000 | 0 | 0 | 10 / — | 1 | 2,000 | 179,241 B | 41 ms | — |
| 10,000 | 20 | 8 KiB | 10 / 500 | 1 each | 12,499 | 179,751 B | 84 ms | 2,159 ms |

The near-constant batch response size confirms that the stored body and
history are not serialized. The higher D1 read count with history remains a
real scaling cost. The old route uses `.first()`, so comparable D1 row metadata
are unavailable. Both local elapsed figures include Worker HTTP dispatch and
JSON parsing but exclude Go rendering and external network latency. The
batched route ran first; warmup and execution order affect these single-run
times. They cannot establish production p95/p99.

## Remaining acceptance

The fixture exercises the Worker endpoint, not Go's Markdown renderer. The
earlier real local Go↔Worker test covers their contract at smaller scale.
Worker memory cannot be attributed to a single request from this Vitest
fixture; a platform metric or a separately controlled Workerd process
measurement is still needed. The full S3 gate also needs same-load open,
closed, and mixed comparisons against the old path, foreground p95/p99,
failure rates, D1 queueing, and production coverage of the policy-query rows.
This evidence
does not close Share #30, Enricher #20, or #16.
