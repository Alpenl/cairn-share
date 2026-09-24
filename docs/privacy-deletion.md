# Bookmark deletion and private storage

The App-token `DELETE /api/links/:id` deletes the bookmark and its D1-owned source, evidence, run, decision, curation, entity, selection and operation rows. Migration `0026_privacy_deletion.sql` also deletes link-scoped budget records, advances the internal read-cache generation and writes a minimal numeric deletion receipt in the same D1 transaction. Global budget totals and shared question/taxonomy definitions are retained. The migration repairs existing orphan link-scoped budgets and rejects future orphan inserts/updates.

A deletion receipt contains only `link_id`, `deleted_at` and `next_cleanup_at`. It intentionally has no cascading parent: clearing it together with the bookmark would lose the storage-cleanup obligation. Receipts remain to confirm retries and detect a late R2 write after a Worker interruption; they contain no source text, URLs, object bodies, curation, run answers or provider errors.

After the transaction, the Worker removes **all** objects and metadata under the exact `enrichment/<id>/` prefix, including historical images no longer listed in `links.images`. Each request performs at most four list/delete pages of up to 100 objects. A successful pass returns 204. Storage failure or a longer prefix returns 503 `deletion_cleanup_pending` with `Retry-After: 300`; D1 content is already gone, and retrying the same DELETE continues cleanup. A known completed receipt returns 204 again; an unknown ID returns JSON 404. Enricher credentials do not grant App deletion permission.

Image reads check that the link exists both before and after R2 I/O, including conditional 304 handling. An upload finishing after deletion rechecks its lease and invokes cleanup. If an isolate dies during the R2 put, recovery uses persisted receipts and the scheduled orphan scan. D1 and R2 are separate services: deletion is not represented as a distributed atomic transaction, and an interrupted late write can require scheduled recovery. A storage outage prevents physical purge until storage recovers, while application reads remain denied.

The configured five-minute Cron handler processes up to 20 due receipts and scans one 100-object page under `enrichment/` for legacy orphan prefixes. The scan persists its cursor and wraps at EOF; newly discovered receipts are picked up on a following tick. Failed/incomplete purges are due again after five minutes; completed receipts are rechecked after 24 hours to catch interrupted late puts. The queue is ordered by due time and ID. These are scheduling intervals, not a purge SLA: backlog, missed Cron invocations and outages can extend completion. Live link IDs and unrelated R2 prefixes are excluded, including if a historical orphan receipt predates creation of that numeric ID.

Authenticated responses now use `Cache-Control: private, no-store`; internal generation-keyed Cache API entries retain the existing 15-second expiry. Deletion invalidates their generation atomically; old entries age out rather than requiring a global Cloudflare purge. Previously downloaded files, older browser caches and client-maintained offline databases cannot be remotely erased by this API. Client cache/deletion behavior and broader age-based retention of live history remain separate acceptance items.

## Rollout and recovery (not executed here)

1. Back up D1 and record the installed migration version; apply migrations through 0027 before deploying this Worker. Do not edit older published migrations.
2. Deploy the compatible Worker with its Cron trigger and existing D1/R2 bindings. Check scheduled invocation success and the due count: `SELECT COUNT(*) FROM privacy_deletions WHERE next_cleanup_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Investigate a growing backlog; do not drop receipts to make the count disappear.
3. A failed user deletion may be safely retried with the same ID. No new model call or source retrieval is needed. A live link must never be removed merely because its age or image key resembles an orphan.
4. On application rollback keep migration 0026 and a compatible maintenance worker running. Older DELETE SQL still creates receipts via the database trigger, but an older image-serving executable lacks the new existence check; do not claim equivalent privacy guarantees for that rollback. No destructive down migration.

No production migration, Cron deployment or remote data cleanup is performed by local verification. Tests use synthetic data and local D1/R2.

References: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) documents strong consistency and list/delete limits; [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) documents the scheduled handler and configuration. Checked 2026-09-23.


## Android deletion recovery

Android records the explicit deletion intent in its existing DataStore before sending DELETE. The journal contains only the full account/server fingerprint, numeric link ID and confirmation bit. A confirmed 204, or the specific 503 `deletion_cleanup_pending`, atomically removes that account's queued curation actions and records confirmation. Generic 503, malformed responses, authorization errors and transport errors do not count as confirmation; the intent and previous actions remain for a retry. The pending intent blocks curation replay and new curation enqueues for that account/link. Startup or account activation retries pending deletions once; it does not run an unbounded network retry loop. A storage write failure is shown and does not claim completed local cleanup.

The shared queue mutex serializes deletion against in-flight curation acknowledgements. Confirmed IDs are removed from root, library, search, detail-load, edit-draft and v2 selection/draft/conflict/busy/queue views. Persisted confirmation filters late and subsequently stale list/detail/selection responses, including after process recreation and A→B→A account changes. An old-account callback cannot navigate the new account, while its durable confirmation still clears the correct account's owned data. Other accounts' actions are retained; ambiguous legacy suffix-only actions cannot safely be attributed and are retained outside the deleted item's visible state until explicit ownership handling.

The bounded decoded-image memory cache uses the account fingerprint, not the raw token, as its key. Confirmation evicts the matching account/link images and permanently rejects late writes for that pair in the running process; persisted confirmations restore that boundary on restart. Composables observe invalidation and drop their remembered bitmap too. Other accounts and bookmark IDs remain separate.

The UI distinguishes “收藏已移除，附件正在后台清理” from full deletion confirmation. Server Cron owns attachment cleanup after that response; Android does not manufacture a physical-purge confirmation. These guards apply to this app's managed views and action store; exported files, system screenshots or previously cached data owned by other applications are outside its erase capability.


## Private rerank cache (0027)

The internal rerank cache stores the exact private provider request and answer distributions, with hashes for filter scope and rubric and versioned candidate references. It contains no provider credentials. Enricher credentials are required; public/App readers cannot access it. Deleting **any** referenced bookmark removes the entire shared cache entry and all its candidate references in the same D1 transaction. Anonymous global budget consumption is retained.

Entries have a fixed 24-hour lifetime from claim, including pending and failed entries; hits never extend it and unknown outcomes are not re-granted within that window. Reads reject expiry immediately. Claim and the existing five-minute privacy Cron each prune at most 100 expired entries; claim also atomically removes its own expired key before allocation. The cache has a deployment cap of 200 entries. Physical purge can lag during missed invocations or an outage; the lifetime is not a physical-purge SLA. An old cache writer cannot complete after a canonical revision change or deletion. Migration 0027 also advances personal revisions for note/why/curation status edits and body revisions for title/summary/status/URL edits; same-value writes do not advance them.

Apply 0027 before deploying the new Worker. On rollback keep the migration and compatible cache maintenance, disable reranking before reverting the consumer, and do not claim that an older enabled consumer preserves result deduplication. No destructive down migration or production migration was performed for this change.


## 0028 实体判断缓存

`entity_cache` 私有保存实际模型请求、候选与精确原文位置、原始 Noul 判断和绑定快照身份。
仅 enricher token 可访问；收藏或证据快照删除通过外键级联清除整条记录。全表删除测试
实际填充该表后核对清零，匿名全局预算不退回。

从首次 claim 固定 24 小时，命中不续期；200 项上限、请求及隐私 Cron 每次最多清理
100 条，当前过期 key 在 claim 事务中单独删除。过期即拒读，物理删除时间受停机影响；
不把缓存期限扩展宣称为历史 run/evidence 的保留策略。旧消费者回退前关闭实体扩展，
保留兼容 Worker/迁移与清理任务。0028 还补来源链接单独变化时的内容版本失效，
保护旧实体状态及异步写回；同值来源与人工备注不会额外推进该版本。未执行生产迁移。
