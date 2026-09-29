# B01/B02 stage-filtered claim query cost

The source/reading instance-local pause introduced a stage filter in the scheduled claim. Before this change, a 2,000-link D1 fixture with 1,999 pending links in the excluded stage and the only eligible link last in priority order read 2,002 rows per claim. The reverse stage skew had the same result. A paused stage could therefore impose a full scan on each scheduler round.

Migration `0047_source_stage_priority.sql` adds a partial expression index on the next source component, manual priority and ID. The stage-only query constrains that leading expression; the common both-stage query continues to use `links_manual_priority_idx` and no longer evaluates a redundant stage mask. The component expression is the same as the existing claim and Go source-first decision: an explicit refresh or empty original text needs source retrieval; otherwise reading can use the stored text.

The D1 plan test covers both directions of the 2,000-link skew, an empty permitted stage and manual-priority ordering. Each stage-only query uses `links_source_stage_priority_idx`, avoids a temporary sort and reads fewer than 20 rows. The existing both-stage query also remains below 20 rows. Worker unit tests, TypeScript type checking, Wrangler dry-run and a real local Go→Worker/D1 stage-pause integration exercise the new migration and query.

These fixture counts do not prove a production latency gain. Migration time, index size, write amplification from source/status updates, total SQL queries per scheduler round, memory and p95/p99 under the #20 open/closed mixed loads remain to measure before the performance goal can be accepted. No remote migration or deployment was made.
