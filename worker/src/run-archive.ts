import { canonicalJSON } from "./domain";

export type ArchiveEnv = { DB: D1Database; ENRICHMENT_IMAGES?: R2Bucket };
export interface ArchivedPayloadRow {
  id?: number;
  archive_key?: string | null; archive_hash?: string | null; archive_bytes?: number | null;
  policy: string; answers: string; usage: string; raw_judgments: string | null;
}
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Verify private object identity before returning evidence to a strict reuse
// validator. Missing/corrupt archives are errors, never empty successful runs.
export async function hydrateRunPayload<T extends ArchivedPayloadRow>(env: ArchiveEnv, row: T): Promise<T> {
  if (!row.archive_key) return row;
  if (!env.ENRICHMENT_IMAGES || !row.archive_hash || !row.archive_bytes || row.archive_bytes > 4 << 20) throw new Error("run_archive_unavailable");
  const object = await env.ENRICHMENT_IMAGES.get(row.archive_key);
  if (!object || object.size !== row.archive_bytes) throw new Error("run_archive_unavailable");
  const payload = await object.text();
  if (await hash(payload) !== row.archive_hash) throw new Error("run_archive_corrupt");
  // The private object may have been fetched while a bookmark deletion won.
  // Recheck its surviving canonical reference before returning any payload.
  if (row.id !== undefined && !await env.DB.prepare(`SELECT 1 FROM classification_runs r JOIN links l ON l.id=r.link_id
    WHERE r.id=? AND r.archive_key=? AND r.archive_hash=?`).bind(row.id, row.archive_key, row.archive_hash).first())
    throw new Error("run_archive_unavailable");
  const parsed = JSON.parse(payload) as { version: number; policy: string; answers: string; usage: string; raw_judgments: string | null };
  if (parsed.version !== 1 || ![parsed.policy, parsed.answers, parsed.usage].every(v => typeof v === "string") ||
    parsed.raw_judgments !== null && typeof parsed.raw_judgments !== "string") throw new Error("run_archive_corrupt");
  return { ...row, policy: parsed.policy, answers: parsed.answers, usage: parsed.usage, raw_judgments: parsed.raw_judgments };
}

// Write objects first, then clear D1 payloads only while the immutable payload
// hash and retention/current-run fences still hold. A crash can leave an orphan
// object, but cannot lose the only copy of a run. Existing privacy cleanup owns
// the per-bookmark prefix, including these archives.
export async function archiveOldRunPayloads(env: ArchiveEnv, cutoff: string, now: string): Promise<number> {
  if (!env.ENRICHMENT_IMAGES) return 0;
  const rows = await env.DB.prepare(`SELECT id,link_id,payload_hash,policy,answers,usage,raw_judgments FROM classification_runs r
    WHERE r.created_at<? AND r.archive_key IS NULL AND r.status IN ('succeeded','partial')
      AND length(r.payload_hash)=64
      AND NOT EXISTS(SELECT 1 FROM links l WHERE l.id=r.link_id AND l.content_revision=r.content_revision
        AND r.id=(SELECT MAX(id) FROM classification_runs latest WHERE latest.link_id=r.link_id AND latest.content_revision=r.content_revision))
      AND NOT EXISTS(SELECT 1 FROM classification_decisions d WHERE d.link_id=r.link_id
        AND d.id=(SELECT MAX(id) FROM classification_decisions latest WHERE latest.link_id=r.link_id)
        AND (d.run_id=r.id OR EXISTS(SELECT 1 FROM classification_decision_runs ref WHERE ref.decision_id=d.id AND ref.run_id=r.id)))
    ORDER BY r.created_at,r.id LIMIT 20`).bind(cutoff).all<{ id: number; link_id: number; payload_hash: string } & ArchivedPayloadRow>();
  let archived = 0;
  for (const row of rows.results) {
    const payload = canonicalJSON({ version: 1, policy: row.policy, answers: row.answers, usage: row.usage, raw_judgments: row.raw_judgments });
    const bytes = new TextEncoder().encode(payload).length;
    if (bytes > 4 << 20) continue;
    const digest = await hash(payload), key = `enrichment/${row.link_id}/history/classification/${row.id}/${digest}.json`;
    await env.ENRICHMENT_IMAGES.put(key, payload, { httpMetadata: { contentType: "application/json" } });
    const result = await env.DB.prepare(`UPDATE classification_runs SET archive_key=?,archive_hash=?,archive_bytes=?,archived_at=?,
      policy='{}',answers='{}',usage='{}',raw_judgments=NULL WHERE id=? AND link_id=? AND payload_hash=? AND archive_key IS NULL AND created_at<?
      AND NOT EXISTS(SELECT 1 FROM links l WHERE l.id=classification_runs.link_id AND l.content_revision=classification_runs.content_revision
        AND classification_runs.id=(SELECT MAX(id) FROM classification_runs latest WHERE latest.link_id=l.id AND latest.content_revision=l.content_revision))
      AND NOT EXISTS(SELECT 1 FROM classification_decisions d WHERE d.link_id=classification_runs.link_id
        AND d.id=(SELECT MAX(id) FROM classification_decisions latest WHERE latest.link_id=classification_runs.link_id)
        AND (d.run_id=classification_runs.id OR EXISTS(SELECT 1 FROM classification_decision_runs ref WHERE ref.decision_id=d.id AND ref.run_id=classification_runs.id)))`)
      .bind(key, digest, bytes, now, row.id, row.link_id, row.payload_hash, cutoff).run();
    if (result.meta.changes) archived++;
    else if (!await env.DB.prepare("SELECT 1 FROM classification_runs WHERE id=? AND archive_key=?").bind(row.id, key).first())
      await env.ENRICHMENT_IMAGES.delete(key);
  }
  return archived;
}
