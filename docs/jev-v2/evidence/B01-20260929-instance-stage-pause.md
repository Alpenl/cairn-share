# B01/B02 source-stage pause contract

The Worker exposes `source_stage_pause` in its internal source-lease capability handshake. Only callers sending `X-Cairn-Source-Stage-Pause: 1` may mask source or reading candidates and receive `source_component` in the claim response. Older strict clients keep the previous response shape. The stage mask is applied in the same candidate query as the existing provider gate; unrelated stage work can still be leased.

`POST /api/enrichment/jobs/:id/local-defer` releases an unused lease after an instance-local source/reading pause. The release checks lease ownership and the paid-attempt ledger in the D1 transaction; a matching reservation or uncertain provider result returns a conflict. An unspent first attempt is refunded, while a previous paid stage keeps its attempt count. A transient fault reported without a matching reservation is treated as an admission/contract failure rather than a provider outage: the unused lease is released without opening the shared supplier gate.

Validation: stage-mask, legacy response shape, unused-lease refund, previous paid-stage preservation, probe release, ledger conflict, and 2,000-row candidate-plan tests; TypeScript and Wrangler dry-run checks. The paired Go evidence records the real local Worker/D1 test. This change does not deploy, migrate remote D1, or make a paid request.

Remaining: per-instance pause state is intentionally owned by Go. Supplier attempts already reserved or in flight remain governed by the existing ledger and unknown-result recovery path. Repeated restart behavior and production fault-rate evidence remain for cross-repository acceptance.
