# OBS-02: provider recovery outcome events (local slice)

The Worker now emits a fixed `provider_recovery` event for operator-authorized
source and reading recovery requests. It distinguishes a first committed
recovery, an identical replay, a rejected request and an unhandled failure.
The existing `worker_request` event now names both recovery routes instead of
`other`. These events follow the existing off/basic/diagnostic switch and
share its bounded per-isolate export queue and drop count. Logging failures do
not change the business response.

The event contains only schema/config version, stage, outcome and HTTP status.
It does not contain the link ID, operation key, actor, response ID, source,
reading text, URL or lease token. The private D1 recovery receipt remains the
source of truth for a committed result. A log entry or missing log entry cannot
establish whether the external provider charged for a request.

Local verification: 38 Worker test files / 375 tests, TypeScript typecheck and
Wrangler deployment dry-run passed. New tests cover source and reading commit
versus replay, rejection, exact safe fields, named route templates and the
runtime off switch. This does not complete OBS-02: accepted/claim/paid-stage
events, trace context, a private deletable correlation store, complete D1
cost coverage, collector failure behavior and production observation remain
open. No remote migration or deployment was made.
