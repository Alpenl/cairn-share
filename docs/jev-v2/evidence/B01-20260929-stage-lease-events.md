# B01 / OBS: stage-lease release events

Worker now emits a fixed `stage_lease` lifecycle event after the D1 operation for an instance-local `local-defer` or a transient failure reported before any matching provider reservation. It distinguishes a released unused lease from a refused release. The event carries only action, source/reading stage, outcome, status and active policy version. It carries no bookmark ID, lease token, source URL, request body or provider response.

The event uses the existing off/basic/diagnostic Worker policy, per-isolate bound and drop counter. A test enables basic logging, verifies successful and refused local deferral plus a no-reservation fault, checks that private fields are absent, then switches logging off and verifies no further export. Source leases, attempt refunds and provider-result uncertainty continue to be decided by D1, independently of log availability.

Verification: the source-lease test file, TypeScript type check and Wrangler dry-run pass; fixed-HEAD CI and the paired Go→local Worker/D1 integration are recorded in the related issue once complete. The event stream is optional evidence, not an authoritative billable-call count. Exporter loss, durable correlation, metrics/traces controls and the observation-period report remain open.
