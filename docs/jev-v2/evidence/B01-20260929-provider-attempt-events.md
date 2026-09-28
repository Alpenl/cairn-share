# OBS-02: paid permit and settlement events (local slice)

The Worker now emits fixed `provider_attempt` events for durable permit
reservations and settlement reports. Reservation distinguishes a newly granted
permit, the same operation already reserved, and rejection. Settlement
distinguishes the first persisted response report, identical replay, and
rejection. The event records the stage, HTTP result and a fixed rejection
reason where known. A settled event also records the provider HTTP status and
whether the report carried a response ID. It does not include the operation
key, model prompt, response ID, lease, link ID, actor or model output.

The settlement UPDATE uses one `RETURNING stage` query via D1 `run()`, keeping
its SQL metadata available for later OBS-02 cost instrumentation. Events use
the existing off/basic/diagnostic switch and bounded export/drop counter.
They are diagnostic: a reserved permit does not prove the supplier received a
POST, and even a reported HTTP response does not independently prove billing.
The private D1 attempt ledger and supplier evidence remain authoritative.

Local verification: 38 Worker test files / 379 tests, TypeScript typecheck and
Wrangler deploy dry-run passed. Tests cover new and duplicate permits, lease
and budget denial, invalid input, first and duplicate settlement, conflicting
settlement, a reported provider 502 without a response ID, private-field
exclusion and the live off switch. No paid call, remote migration or
deployment was made.

This does not complete OBS-02. Go-side pre-send/provider-receive events,
fallback authorization, operator reconciliation, completion events, private
deletable correlation, collector failure behavior and same-load overhead
measurements remain open.
