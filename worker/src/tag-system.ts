import { bookmarkFilters, type Env } from "./index";
import { canonicalJSON, compactOverrides, effectiveView, normalizeField, type Override, type OverrideField, type OverrideAction } from "./domain";
import { projectionInputGuard, projectionWrites, rebuildProjection } from "./domain-routes";
import { readSelectionSnapshot, readSelectionSnapshots, readTagSummaries } from "./selection-state";
import { selectionPayload } from "./taxonomy-routes";
import { findTerm, taxonomyV2, normalizeTerm } from "./taxonomy-v2";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Cairn-Tag-System": "1" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (error: string, status = 400, extra = {}) => reply({ error, ...extra }, status);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 200): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const owner = "default"; // Existing deployment is single-account; never trust a caller owner id.
const dimensions: OverrideField[] = ["topics", "resource_kinds", "content_functions", "carriers", "affordances", "form", "use"];
type Custom = { id: string; owner_id: string; label: string; revision: number; status: string; link_count?: number };
const ref = (tag: Custom) => `custom/${tag.owner_id}/${tag.id}`;
const tagged = (tag: Custom) => ({ id: tag.id, owner_id: tag.owner_id, label: tag.label, revision: tag.revision,
  status: tag.status, tag_ref: ref(tag), ...(tag.link_count === undefined ? {} : { link_count: tag.link_count }) });
async function bodyOf(request: Request) {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try { const body: unknown = await request.json(); return object(body) ? body : null; } catch { return null; }
}
async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function normalizeName(label: string) { return normalizeTerm(label.normalize("NFKC")); }
function systemRef(raw: unknown): { field: OverrideField; term: string } | null {
  if (typeof raw !== "string") return null;
  const match = raw.match(/^system\/(topics|resource_kinds|content_functions|carriers|affordances|form|use|forms|uses)\/([a-z][a-z0-9_]{0,39})$/);
  if (!match) return null;
  const field = normalizeField(match[1] === "forms" ? "form" : match[1] === "uses" ? "use" : match[1]);
  if (!field || !findTerm(field === "form" ? "forms" : field === "use" ? "uses" : field, match[2])) return null;
  return { field, term: match[2] };
}
function selectable(value: { field: OverrideField; term: string }) {
  const term = findTerm(value.field === "form" ? "forms" : value.field === "use" ? "uses" : value.field, value.term);
  return term?.active === true && !term.deprecated;
}
async function customOf(env: Env, id: number) {
  const rows = await env.DB.prepare(`SELECT t.id,t.owner_id,t.label,t.revision,t.status FROM custom_tags t
    JOIN custom_tag_links a ON a.tag_id=t.id WHERE a.link_id=? AND t.owner_id=? ORDER BY t.label,t.id`).bind(id, owner).all<Custom>();
  return rows.results.map(tagged);
}
export function contentFunctionsAware(request: Request): boolean {
  return request.headers.get("X-Cairn-Tag-System") === "1" && request.headers.get("X-Cairn-Content-Functions") === "1";
}
export async function attachTagSummaries(env: Env, items: Array<Record<string, unknown>>, internal = false, includeContentFunctions = false) {
  if (!items.length) return items;
  const ids = items.map(item => Number(item.id));
  const { summaries } = await readTagSummaries(env, ids, owner);
  return items.map(item => {
    const summary = summaries.get(Number(item.id));
    if (!summary) return item;
    const enrichment = object(item.enrichment) ? { ...item.enrichment } : null;
    const classification = (value: unknown) => {
      // Keep an unclassified internal item null when it has no system labels;
      // optional custom labels never fabricate a completed classification.
      if (internal && value === null && !summary.topics.length && !summary.resource_kinds.length &&
        !(includeContentFunctions && summary.content_functions.length)) return null;
      const prior = object(value) ? value : {
        why_suggestion: "", entities: [], uncertainty: false, taxonomy_version: taxonomyV2().version, discarded_tags: [], form: "", use: ""
      };
      return { ...prior, topics: summary.topics, resource_kinds: summary.resource_kinds,
        ...(includeContentFunctions ? { content_functions: summary.content_functions } : {}) };
    };
    if (enrichment) enrichment.classification = classification(enrichment.classification);
    return { ...item, ...(enrichment ? { enrichment } : {}),
      ...(internal ? { classification: classification(item.classification) } : {}),
      custom_tags: summary.custom_tags.map(tagged) };
  });
}
async function manualOrigins(env: Env, id: number, revision: number) {
  const rows = await env.DB.prepare(`SELECT f.field,f.term,f.action,o.actions,o.context FROM tag_change_facts f
    LEFT JOIN tag_operations o ON o.operation_key=f.operation_id WHERE f.link_id=? AND f.revision<=? AND f.field<>'operation'
    ORDER BY f.revision,f.id`).bind(id, revision).all<{ field: string; term: string; action: string; actions: string | null; context: string | null }>();
  const origins: Record<string, "accept" | "confirm"> = {};
  for (const row of rows.results) {
    const context = row.context ? JSON.parse(row.context) as { restored_actions?: Record<string, "accept" | "confirm"> } : {};
    const logical = row.actions ? JSON.parse(row.actions) as Action[] : [];
    const key = `${row.field}:${row.term}`;
    origins[key] = context.restored_actions?.[key] ?? (logical.some(a => a.action === "confirm" &&
      systemRef(a.tag_ref)?.field === row.field && systemRef(a.tag_ref)?.term === row.term) ? "confirm" : "accept");
  }
  return origins;
}
export async function tagPayload(env: Env, id: number) {
  const snapshot = await readSelectionSnapshot(env, id);
  if (!snapshot) return null;
  const params = new URLSearchParams({ include_state: "1", include_automatic: "1", tag_system: "1" });
  const payload = selectionPayload(snapshot, id, params);
  const origins = await manualOrigins(env, id, snapshot.link.personal_revision);
  for (const [dimension, state] of Object.entries(payload.state!.fields)) {
    for (const value of state.values) {
      if (value.origin !== "human") continue;
      const confirmation = origins[`${dimension}:${value.term}`] === "confirm";
      Object.assign(value, { confirmed: confirmation, human_action: confirmation ? "confirm" : "accept" });
    }
  }
  const evidence = snapshot.state.evidence;
  const archive = await env.DB.prepare(`SELECT CASE WHEN length(trim(COALESCE(original_text,'')))>0 THEN 1 ELSE 0 END AS available
    FROM links WHERE id=? AND content_revision=?`).bind(id, snapshot.contentRevision).first<{ available: number }>();
  const sourceStatus = evidence ? evidence.completeness === "empty" ? "empty" :
    evidence.truncated || ["partial", "truncated"].includes(evidence.completeness) ? "partial" : "available" : archive ? archive.available ? "available" : "empty" : "unknown";
  return { ...payload, content_revision: snapshot.contentRevision, decision_id: snapshot.decisionId,
    source_state: { status: sourceStatus, basis: evidence ? "evidence_snapshot" : "archive", content_revision: snapshot.contentRevision, evidence_snapshot_id: evidence?.id ?? null },
    custom_tags: await customOf(env, id) };
}
type Action = Record<string, unknown>;
type Receipt = { link_id: number; payload_hash: string; revision: number; actions: string; before_overrides: string; before_custom: string; reverts_operation: string | null; context?: string };

async function applyActions(request: Request, env: Env, id: number) {
  const body = await bodyOf(request);
  if (!body || !text(body.operation_key) || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0 ||
    !Array.isArray(body.actions) || !body.actions.length || body.actions.length > 20 || !body.actions.every(object)) return fail("invalid_tag_operation");
  const actions = body.actions as Action[], key = body.operation_key, payloadHash = await hash({ id, body });
  const stored = () => env.DB.prepare(`SELECT link_id,payload_hash,revision,actions,before_overrides,before_custom,reverts_operation
    FROM tag_operations WHERE operation_key=?`).bind(key).first<Receipt>();
  const acknowledge = async (receipt: Receipt, replayed: boolean) => receipt.link_id !== id || receipt.payload_hash !== payloadHash
    ? fail("operation_conflict", 409) : reply({ ...await tagPayload(env, id), operation_id: key, operation_revision: receipt.revision, replayed });
  const prior = await stored();
  if (prior) { await rebuildProjection(env, id); return acknowledge(prior, true); }
  const snapshot = await readSelectionSnapshot(env, id);
  if (!snapshot) return fail("not_found", 404);
  if (body.expected_revision !== snapshot.link.personal_revision) return fail("revision_conflict", 409, { current: await tagPayload(env, id) });
  const requiresRead = actions.some(a => ["confirm", "set_empty", "reset_group"].includes(String(a.action)));
  if ((requiresRead && (body.expected_decision_id === undefined || body.expected_content_revision === undefined)) ||
    (body.expected_decision_id !== undefined && body.expected_decision_id !== snapshot.decisionId) ||
    (body.expected_content_revision !== undefined && body.expected_content_revision !== snapshot.contentRevision)) {
    return fail("decision_conflict", 409, { current: await tagPayload(env, id) });
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 1000)) return fail("invalid_reason");
  const now = new Date().toISOString(), revision = snapshot.link.personal_revision + 1;
  const changes: Override[] = [], customBefore = await customOf(env, id), customAfter = new Set(customBefore.map(t => t.id));
  const customBasis = new Map<string, { revision: number; status: string }>();
  let undo: string | null = null;
  let restoredActions: Record<string, "accept" | "confirm"> | undefined;
  const add = (field: OverrideField, term: string, action: OverrideAction, source: Override["source"] = "human", confirmed = true) =>
    changes.push({ field, term, action, source, confirmed, revision });
  for (const action of actions) {
    const name = String(action.action);
    if (["accept", "confirm", "reject", "reset"].includes(name)) {
      const target = systemRef(action.tag_ref);
      if (!target) return fail("invalid_tag_ref");
      if (["accept", "confirm"].includes(name) && !selectable(target)) return fail("tag_deprecated", 409);
      if (name === "confirm" && !((snapshot.view[target.field] ?? []) as string[]).includes(target.term)) return fail("tag_not_effective", 409);
      add(target.field, target.term, name === "confirm" ? "accept" : name as OverrideAction);
    } else if (name === "replace") {
      const from = systemRef(action.from_tag_ref), to = systemRef(action.to_tag_ref);
      if (!from || !to || !selectable(to) || (from.field === to.field && from.term === to.term)) return fail("invalid_replacement");
      add(from.field, from.term, "reject"); add(to.field, to.term, "accept");
    } else if (["set_empty", "reset_group"].includes(name)) {
      const field = normalizeField(action.dimension);
      if (!field || !dimensions.includes(field)) return fail("invalid_dimension");
      add(field, "", name === "set_empty" ? "set_empty" : "reset");
    } else if (["attach", "detach"].includes(name)) {
      if (typeof action.tag_ref !== "string" || !action.tag_ref.startsWith(`custom/${owner}/`)) return fail("invalid_tag_ref");
      const tagID = action.tag_ref.slice(`custom/${owner}/`.length);
      const tag = await env.DB.prepare(`SELECT id,status,revision FROM custom_tags WHERE id=? AND owner_id=?`).bind(tagID, owner).first<{ id: string; status: string; revision: number }>();
      if (!tag || (name === "attach" && tag.status !== "active")) return fail("invalid_custom_tag");
      customBasis.set(tagID, { revision: tag.revision, status: tag.status });
      if (name === "attach") customAfter.add(tagID); else customAfter.delete(tagID);
    } else if (name === "undo") {
      if (actions.length !== 1 || !text(action.operation_id)) return fail("invalid_undo");
      const previous = await env.DB.prepare(`SELECT link_id,revision,actions,before_overrides,before_custom,context FROM tag_operations WHERE operation_key=?`)
        .bind(action.operation_id).first<Receipt>();
      if (!previous || previous.link_id !== id || previous.revision !== snapshot.link.personal_revision) return fail("undo_conflict", 409);
      if (await env.DB.prepare(`SELECT operation_key FROM tag_operations WHERE reverts_operation=?`).bind(action.operation_id).first()) return fail("already_undone", 409);
      undo = action.operation_id;
      restoredActions = previous.context ? (JSON.parse(previous.context) as { before_origins?: Record<string, "accept" | "confirm"> }).before_origins : undefined;
      const priorActions = JSON.parse(previous.actions) as Action[];
      if (priorActions.some(a => a.action === "undo")) return fail("unsupported_redo", 409);
      const fields = new Set<OverrideField>();
      for (const entry of priorActions) {
        for (const raw of [entry.tag_ref, entry.from_tag_ref, entry.to_tag_ref]) { const value = systemRef(raw); if (value) fields.add(value.field); }
        const field = normalizeField(entry.dimension); if (field) fields.add(field);
      }
      const before = JSON.parse(previous.before_overrides) as Override[];
      for (const field of fields) {
        add(field, "", "reset");
        for (const priorOverride of before.filter(o => o.field === field)) add(field, priorOverride.term, priorOverride.action, priorOverride.source, priorOverride.confirmed);
      }
      customAfter.clear();
      for (const tag of JSON.parse(previous.before_custom) as Custom[]) customAfter.add(tag.id);
      for (const tagID of customAfter) {
        const definition = await env.DB.prepare(`SELECT revision,status FROM custom_tags WHERE id=? AND owner_id=?`).bind(tagID, owner).first<{ revision: number; status: string }>();
        if (!definition || definition.status !== "active") return fail("custom_definition_conflict", 409);
        customBasis.set(tagID, definition);
      }
    } else return fail("invalid_action");
  }
  const future = effectiveView(snapshot.automatic, [...snapshot.projectionInput.overrides, ...changes]);
  const display = (await env.DB.prepare(`SELECT dimension,term_id,label,display_revision FROM taxonomy_display_overrides`).all<{
    dimension: string; term_id: string; label: string; display_revision: number
  }>()).results;
  const context = { actor_type: "human", actor_id: owner, content_revision: snapshot.contentRevision,
    decision_id: snapshot.decisionId, taxonomy_version: taxonomyV2().version, definition_version: taxonomyV2().definition_version,
    reason: body.reason ?? null, basis: snapshot.state, before_origins: await manualOrigins(env, id, snapshot.link.personal_revision),
    ...(restoredActions ? { restored_actions: restoredActions } : {}), tag_definitions: changes.map(c => {
      const dimension = c.field === "form" ? "forms" : c.field === "use" ? "uses" : c.field;
      const overlay = display.find(d => d.dimension === dimension && d.term_id === c.term);
      return { field: c.field, term: c.term, ...(findTerm(dimension, c.term) ?? {}),
        ...(overlay ? { label: overlay.label, display_revision: overlay.display_revision } : {}) };
    }) };
  const guard = projectionInputGuard(id, snapshot);
  for (const [tagID, basis] of customBasis) {
    guard.sql += ` AND EXISTS(SELECT 1 FROM custom_tags WHERE id=? AND owner_id=? AND revision=? AND status=?)`;
    guard.bindings.push(tagID, owner, basis.revision, basis.status);
  }
  const appliedGuard = { sql: `EXISTS(SELECT 1 FROM tag_operations WHERE operation_key=? AND payload_hash=? AND link_id=? AND revision=?)
    AND EXISTS(SELECT 1 FROM links WHERE id=? AND personal_revision=? AND content_revision=?)
    AND COALESCE((SELECT MAX(id) FROM classification_decisions WHERE link_id=?),0)=?`,
    bindings: [key, payloadHash, id, revision, id, revision, snapshot.contentRevision, id, snapshot.decisionId] };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO tag_operations(operation_key,link_id,payload_hash,revision,actions,before_overrides,before_custom,before_effective,after_effective,context,reverts_operation,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`)
      .bind(key, id, payloadHash, revision, canonicalJSON(actions), canonicalJSON(compactOverrides(snapshot.projectionInput.overrides)), canonicalJSON(customBefore),
        canonicalJSON(snapshot.view), canonicalJSON({ ...future, custom_tags: [...customAfter] }), canonicalJSON(context), undo, now, ...guard.bindings)
  ];
  changes.forEach((change, i) => {
    const operation = `${key}:tag:${i}`;
    statements.push(env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`)
      .bind(id, change.field, change.term, change.action, change.source, change.confirmed ? 1 : 0, revision, operation, now, ...guard.bindings));
    statements.push(env.DB.prepare(`UPDATE tag_change_facts SET operation_id=?,context=? WHERE operation_key=?`)
      .bind(key, canonicalJSON(context), operation));
  });
  for (const tag of customBefore.filter(t => !customAfter.has(t.id))) {
    statements.push(env.DB.prepare(`DELETE FROM custom_tag_links WHERE link_id=? AND tag_id=? AND ${guard.sql}`).bind(id, tag.id, ...guard.bindings));
  }
  for (const tagID of [...customAfter].filter(t => !customBefore.some(before => before.id === t))) {
    statements.push(env.DB.prepare(`INSERT INTO custom_tag_links(link_id,tag_id,created_at) SELECT ?,?,? WHERE ${guard.sql} ON CONFLICT DO NOTHING`)
      .bind(id, tagID, now, ...guard.bindings));
  }
  // Custom-only actions also have a permanent per-bookmark fact.
  statements.push(env.DB.prepare(`INSERT INTO tag_change_facts(link_id,operation_key,operation_id,field,term,action,source,revision,context,created_at)
    SELECT ?,?,?, 'operation','',?,'human',?,?,? WHERE ${guard.sql}`)
    .bind(id, `${key}:operation`, key, actions.length === 1 ? String(actions[0].action) : "batch", revision, canonicalJSON(context), now, ...guard.bindings));
  statements.push(env.DB.prepare(`UPDATE links SET personal_revision=? WHERE id=? AND ${guard.sql}`).bind(revision, id, ...guard.bindings));
  statements.push(...projectionWrites(env, id, revision, future, snapshot.automatic, snapshot.projected, snapshot.contentRevision,
    snapshot.stale, snapshot.decisionId, snapshot.projectionInput.classification, appliedGuard));
  try { await env.DB.batch(statements); } catch (cause) { const receipt = await stored(); if (receipt) return acknowledge(receipt, true); throw cause; }
  const receipt = await stored();
  return receipt ? acknowledge(receipt, false) : fail("revision_conflict", 409, { current: await tagPayload(env, id) });
}

async function history(env: Env, id: number, params: URLSearchParams) {
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 30))), before = Number(params.get("before_id") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(before)) return fail("invalid_pagination");
  if (!(await env.DB.prepare(`SELECT id FROM links WHERE id=?`).bind(id).first())) return fail("not_found", 404);
  const facts = await env.DB.prepare(`SELECT f.id,f.operation_id,f.field,f.term,f.action,f.source,f.revision,f.context,f.created_at,
    o.actions,o.before_effective,o.after_effective,o.reverts_operation
    FROM tag_change_facts f LEFT JOIN tag_operations o ON o.operation_key=f.operation_id
    WHERE f.link_id=? AND f.id<? AND (o.operation_key IS NULL OR f.field='operation') ORDER BY f.id DESC LIMIT ?`)
    .bind(id, before, limit + 1).all<Record<string, unknown>>();
  const rows = facts.results.slice(0, limit);
  return reply({ events: rows.map(r => ({ ...r, tag_ref: r.field === "custom_tags" ? `custom/${owner}/${r.term}` : r.field === "operation" ? null : `system/${normalizeField(r.field) ?? r.field}/${r.term}`, context: JSON.parse(String(r.context)),
    actions: r.actions ? JSON.parse(String(r.actions)) : [{ action: r.action, field: r.field, term: r.term }],
    before: r.before_effective ? JSON.parse(String(r.before_effective)) : null, after: r.after_effective ? JSON.parse(String(r.after_effective)) : null })),
    next_before_id: facts.results.length > limit ? rows[rows.length - 1].id : null, coverage: "available_facts", legacy_context: "unknown" });
}

async function customRoute(request: Request, env: Env, id?: string): Promise<Response> {
  if (request.method === "GET" && !id) {
    const rows = await env.DB.prepare(`SELECT t.id,t.owner_id,t.label,t.revision,t.status,COUNT(a.link_id) AS link_count
      FROM custom_tags t LEFT JOIN custom_tag_links a ON a.tag_id=t.id WHERE t.owner_id=? GROUP BY t.id ORDER BY t.label,t.id`).bind(owner).all<Custom>();
    return reply({ tags: rows.results.map(tagged) });
  }
  if (!((request.method === "POST" && !id) || (id && ["PATCH", "DELETE"].includes(request.method)))) return fail("method_not_allowed", 405);
  const body = await bodyOf(request);
  if (!body || !text(body.operation_key)) return fail("invalid_operation_key");
  const payloadHash = await hash({ id: id ?? null, method: request.method, body });
  const key = body.operation_key;
  const stored = await env.DB.prepare(`SELECT payload_hash,after_value FROM custom_tag_operations WHERE operation_key=?`).bind(key).first<{ payload_hash: string; after_value: string }>();
  if (stored) return stored.payload_hash !== payloadHash ? fail("operation_conflict", 409) : reply({ tag: tagged(JSON.parse(stored.after_value) as Custom), replayed: true });
  const current = id ? await env.DB.prepare(`SELECT * FROM custom_tags WHERE id=? AND owner_id=?`).bind(id, owner).first<Custom>() : null;
  if (id && !current) return fail("not_found", 404);
  if (current && body.expected_revision !== current.revision) return fail("revision_conflict", 409, { tag: tagged(current) });
  const deleting = request.method === "DELETE";
  if (!deleting && !text(body.label, 80)) return fail("invalid_label");
  const label = deleting ? current!.label : String(body.label).trim(), normalized = normalizeName(label);
  if (!deleting) {
    const collision = Object.entries(taxonomyV2()).filter(([, v]) => Array.isArray(v)).flatMap(([dimension, terms]) =>
      (terms as Array<{ id: string; label: string; aliases?: string[] }>).filter(t => [t.label, ...(t.aliases ?? [])].some(s => normalizeName(s) === normalized))
        .map(t => ({ tag_ref: `system/${dimension}/${t.id}`, label: t.label })));
    const displays = await env.DB.prepare(`SELECT dimension,term_id,label FROM taxonomy_display_overrides`).all<{ dimension: string; term_id: string; label: string }>();
    collision.push(...displays.results.filter(t => normalizeName(t.label) === normalized).map(t => ({ tag_ref: `system/${t.dimension}/${t.term_id}`, label: t.label })));
    if (collision.length) return fail("system_tag_exists", 409, { matches: collision });
    const duplicate = await env.DB.prepare(`SELECT * FROM custom_tags WHERE owner_id=? AND normalized_label=? AND id<>?`).bind(owner, normalized, id ?? "").first<Custom>();
    if (duplicate) {
      if (id) return fail("custom_tag_exists", 409, { tag: tagged(duplicate) });
      await env.DB.prepare(`INSERT INTO custom_tag_operations(operation_key,tag_id,payload_hash,action,before_value,after_value,created_at)
        VALUES(?,?,?,'reuse',NULL,?,?) ON CONFLICT(operation_key) DO NOTHING`)
        .bind(key, duplicate.id, payloadHash, canonicalJSON(duplicate), new Date().toISOString()).run();
      const receipt = await env.DB.prepare(`SELECT payload_hash,after_value FROM custom_tag_operations WHERE operation_key=?`).bind(key)
        .first<{ payload_hash: string; after_value: string }>();
      return receipt?.payload_hash === payloadHash ? reply({ tag: tagged(JSON.parse(receipt.after_value)), reused: true, replayed: false }) : fail("operation_conflict", 409);
    }
  }
  const links = current ? (await env.DB.prepare(`SELECT link_id FROM custom_tag_links WHERE tag_id=?`).bind(current.id).all<{ link_id: number }>()).results.map(r => r.link_id) : [];
  if (deleting && links.length && body.detach_all !== true) return fail("tag_in_use", 409, { link_count: links.length });
  const now = new Date().toISOString(), tagID = current?.id ?? crypto.randomUUID();
  const next: Custom = { id: tagID, owner_id: owner, label, revision: (current?.revision ?? 0) + 1, status: deleting ? "deprecated" : "active" };
  let guard = current ? `EXISTS(SELECT 1 FROM custom_tags WHERE id=? AND revision=?)` : `NOT EXISTS(SELECT 1 FROM custom_tags WHERE owner_id=? AND normalized_label=?)`;
  const bindings = current ? [tagID, current.revision] : [owner, normalized];
  if (deleting) {
    guard += ` AND (SELECT COUNT(*) FROM custom_tag_links WHERE tag_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM custom_tag_links WHERE tag_id=? AND link_id NOT IN(SELECT value FROM json_each(?)))`;
    bindings.push(tagID, links.length, tagID, JSON.stringify(links));
  }
  const statements = [env.DB.prepare(`INSERT INTO custom_tag_operations(operation_key,tag_id,payload_hash,action,before_value,after_value,created_at)
    SELECT ?,?,?,?,?,?,? WHERE ${guard}`)
    .bind(key, tagID, payloadHash, request.method, current ? canonicalJSON({ ...current, link_count: links.length }) : null, canonicalJSON(next), now, ...bindings)];
  // Definitions must exist before their receipts' FK is inserted.
  if (!current) statements.unshift(env.DB.prepare(`INSERT INTO custom_tags(id,owner_id,label,normalized_label,revision,status,created_at,updated_at)
    VALUES(?,?,?,?,1,'active',?,?)`).bind(tagID, owner, label, normalized, now, now));
  if (!current) {
    // The new definition now exists in this transaction; guard its exact id.
    statements[1] = env.DB.prepare(`INSERT INTO custom_tag_operations(operation_key,tag_id,payload_hash,action,before_value,after_value,created_at)
      VALUES(?,?,?,'POST',NULL,?,?)`).bind(key, tagID, payloadHash, canonicalJSON(next), now);
  } else statements.push(env.DB.prepare(`UPDATE custom_tags SET label=?,normalized_label=?,revision=?,status=?,updated_at=? WHERE id=? AND ${guard}`)
    .bind(label, normalized, next.revision, next.status, now, tagID, ...bindings));
  if (deleting && links.length) {
    const accepted = `EXISTS(SELECT 1 FROM custom_tag_operations WHERE operation_key=? AND payload_hash=?)`;
    statements.push(env.DB.prepare(`INSERT INTO tag_change_facts(link_id,operation_key,operation_id,field,term,action,source,revision,context,created_at)
      SELECT l.id,?||':'||l.id,?,'custom_tags',?,'detach','human',l.personal_revision+1,?,? FROM links l
      WHERE l.id IN(SELECT value FROM json_each(?)) AND ${accepted}`)
      .bind(key, key, tagID, canonicalJSON({ actor_type: "human", actor_id: owner, definition_operation: key,
        before_custom: tagged(current!), after_custom: null }), now, JSON.stringify(links), key, payloadHash));
    statements.push(env.DB.prepare(`UPDATE links SET personal_revision=personal_revision+1 WHERE id IN(SELECT value FROM json_each(?)) AND ${accepted}`)
      .bind(JSON.stringify(links), key, payloadHash));
    statements.push(env.DB.prepare(`DELETE FROM custom_tag_links WHERE tag_id=? AND ${accepted}`).bind(tagID, key, payloadHash));
  }
  try { await env.DB.batch(statements); } catch (cause) {
    const receipt = await env.DB.prepare(`SELECT payload_hash,after_value FROM custom_tag_operations WHERE operation_key=?`).bind(key).first<{ payload_hash: string; after_value: string }>();
    if (receipt) return receipt.payload_hash === payloadHash ? reply({ tag: tagged(JSON.parse(receipt.after_value)), replayed: true }) : fail("operation_conflict", 409);
    const duplicate = await env.DB.prepare(`SELECT * FROM custom_tags WHERE owner_id=? AND normalized_label=? AND id<>?`)
      .bind(owner, normalized, id ?? "").first<Custom>();
    if (duplicate) {
      if (id) return fail("custom_tag_exists", 409, { tag: tagged(duplicate) });
      await env.DB.prepare(`INSERT INTO custom_tag_operations(operation_key,tag_id,payload_hash,action,before_value,after_value,created_at)
        VALUES(?,?,?,'reuse',NULL,?,?) ON CONFLICT(operation_key) DO NOTHING`)
        .bind(key, duplicate.id, payloadHash, canonicalJSON(duplicate), now).run();
      const confirmation = await env.DB.prepare(`SELECT payload_hash,after_value FROM custom_tag_operations WHERE operation_key=?`).bind(key)
        .first<{ payload_hash: string; after_value: string }>();
      return confirmation?.payload_hash === payloadHash ? reply({ tag: tagged(JSON.parse(confirmation.after_value)), reused: true, replayed: false }) : fail("operation_conflict", 409);
    }
    throw cause;
  }
  const receipt = await env.DB.prepare(`SELECT payload_hash FROM custom_tag_operations WHERE operation_key=?`).bind(key).first<{ payload_hash: string }>();
  return receipt ? reply({ tag: tagged(next), replayed: false }) : fail("revision_conflict", 409);
}

async function queryTags(request: Request, env: Env, mode: "counts" | "export") {
  const url = new URL(request.url), query = url.searchParams.get("q")?.trim(), filters = bookmarkFilters(url, query);
  if (filters instanceof Response) return filters;
  const includeContentFunctions = contentFunctionsAware(request);
  const visibleFields = includeContentFunctions ? ["topics", "resource_kinds", "content_functions"] as const : ["topics", "resource_kinds"] as const;
  const learned = url.searchParams.get("learned");
  if (learned && learned !== "all") {
    if (!["1", "0", "true", "false"].includes(learned)) return fail("invalid_filter");
    filters.clauses.push("learned=?"); filters.bindings.push(["1", "true"].includes(learned) ? 1 : 0);
  }
  const where = filters.clauses.length ? `WHERE ${filters.clauses.join(" AND ")}` : "";
  if (mode === "counts") {
    // Count the complete matched collection from one lightweight, authoritative
    // read snapshot. Detailed source/assessment state belongs to export and
    // individual tag reads; no page limit or mutable projection enters counts.
    const { summaries } = await readTagSummaries(env, filters, owner);
    const counts = { topics: new Map<string, number>(), resource_kinds: new Map<string, number>(),
      content_functions: new Map<string, number>(), custom_tags: new Map<string, number>() };
    for (const summary of summaries.values()) {
      for (const field of visibleFields) for (const id of summary[field]) {
        counts[field].set(id, (counts[field].get(id) ?? 0) + 1);
      }
      for (const tag of summary.custom_tags) counts.custom_tags.set(tag.id, (counts.custom_tags.get(tag.id) ?? 0) + 1);
    }
    return reply({ total: summaries.size, ...Object.fromEntries(Object.entries(counts)
      .filter(([field]) => includeContentFunctions || field !== "content_functions").map(([field, terms]) =>
      [field, Array.from(terms, ([id, count]) => ({ id, count }))])) });
  }
  const rows = await env.DB.prepare(`SELECT id,url,note FROM links ${where} ORDER BY id DESC`).bind(...filters.bindings).all<{ id: number; url: string; note: string }>();
  // Export includes origin metadata, so retain full canonical state in bounded
  // reads. Its matched set is never limited by the UI cursor or page size.
  const all = new Map<number, NonNullable<Awaited<ReturnType<typeof readSelectionSnapshot>>>>();
  for (let start = 0; start < rows.results.length; start += 100) {
    const batch = await readSelectionSnapshots(env, rows.results.slice(start, start + 100).map(r => r.id));
    for (const [id, snapshot] of batch.snapshots) all.set(id, snapshot);
  }
  const customs = (await env.DB.prepare(`SELECT a.link_id,t.id,t.owner_id,t.label,t.revision,t.status
    FROM custom_tag_links a JOIN custom_tags t ON t.id=a.tag_id WHERE t.owner_id=? AND a.link_id IN (SELECT value FROM json_each(?))`)
    .bind(owner, JSON.stringify(rows.results.map(row => row.id))).all<Custom & { link_id: number }>()).results;
  const customByLink = new Map<number, Custom[]>();
  for (const tag of customs) {
    const group = customByLink.get(tag.link_id) ?? [];
    group.push(tag); customByLink.set(tag.link_id, group);
  }
  const links = rows.results.map(row => {
    const snapshot = all.get(row.id)!;
    const fields = snapshot.state.fields;
    return { ...row, topics: snapshot.view.topics, resource_kinds: snapshot.view.resource_kinds ?? [],
      ...(includeContentFunctions ? { content_functions: snapshot.view.content_functions } : {}),
      custom_tags: (customByLink.get(row.id) ?? []).map(tagged),
      tags: visibleFields.flatMap(dimension => (snapshot.view[dimension] ?? []).map(id => ({
        tag_ref: `system/${dimension}/${id}`, dimension, id, label: findTerm(dimension, id)?.label ?? id,
        ...fields[dimension].values.find(v => v.term === id) }))) };
  });
  return reply({ taxonomy_version: taxonomyV2().version, links, total: links.length });
}

export async function tagSystemRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const matched = /^\/api\/v2\/(custom-tags(?:\/[^/]+)?|tags\/(counts|export)|links\/\d+\/(tags|tag-history))$/.test(path);
  if (!matched) return null;
  if (request.headers.get("X-Cairn-Tag-System") !== "1") return fail("capability_mismatch", 409);
  const custom = path.match(/^\/api\/v2\/custom-tags(?:\/([a-zA-Z0-9-]+))?$/);
  if (custom) return customRoute(request, env, custom[1]);
  const query = path.match(/^\/api\/v2\/tags\/(counts|export)$/);
  if (query) return request.method === "GET" ? queryTags(request, env, query[1] as "counts" | "export") : fail("method_not_allowed", 405);
  const link = path.match(/^\/api\/v2\/links\/(\d+)\/(tags|tag-history)$/)!;
  const id = Number(link[1]);
  if (link[2] === "tag-history") return request.method === "GET" ? history(env, id, new URL(request.url).searchParams) : fail("method_not_allowed", 405);
  if (request.method === "GET") { const payload = await tagPayload(env, id); return payload ? reply(payload) : fail("not_found", 404); }
  return request.method === "POST" ? applyActions(request, env, id) : fail("method_not_allowed", 405);
}
