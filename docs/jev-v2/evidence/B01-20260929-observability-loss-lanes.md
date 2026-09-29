# B01 / OBS: Worker log loss accounting

Worker logs now have separate, per-isolate one-minute quotas for request summaries and business events. Each lane admits at most 120 records in basic mode or 600 in diagnostic mode. A flood of request summaries therefore cannot consume the slots reserved for provider attempts, lease transitions, manual requests, commits, and recovery events. The upper bound is 240 or 1200 admitted records per isolate per minute, plus logarithmically spaced loss notices and a final notice when a later enabled event starts a new minute.

Every exported record, including a loss notice, carries schema version, UTC timestamp and fixed service name. The timestamp is generated only after the active log switch admits a record.

The first dropped record produces a `worker_log_drops` notice immediately. Subsequent notices report powers of two, and the next active minute reports the final count for the previous minute. An authenticated, read-only `GET /api/internal/observability` exposes current and cumulative admitted, dropped, and synchronous console-write-error counters. It explicitly says `scope: isolate` and `collector_delivery: unknown`; a response from one isolate cannot establish fleet-wide completeness. The control read does not write D1 or log itself, and remains available after logging is switched off. Paid-attempt receipts in D1 remain authoritative.

Tests cover request floods followed by a paid-attempt event, quota loss, immediate and final loss notices, control authentication, off mode, and synchronous console failures. TypeScript and Wrangler dry-run checks pass. Collector-side delivery, process exit before final notices, fleet-wide aggregation, independent metric/trace controls, and the actual-use observation report remain open.
