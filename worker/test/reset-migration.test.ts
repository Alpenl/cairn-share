import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "vitest";
import { effectiveView, EMPTY_AUTOMATIC, OVERRIDE_FIELDS, normalizeField, type AutomaticView, type Override } from "../src/domain";
import { readSelectionSnapshot } from "../src/selection-state";
import vectors from "./fixtures/override-vectors.json";
import worker from "../src/index";

const dbEnv = { DB: env.DB };
const json = JSON.stringify;
const date = "2026-09-22T00:00:00Z";
let nextId = 0;

async function beforeUpgrade() {
  await reset(); nextId = 0;
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name < "0024"));
}

type Action = Pick<Override, "term" | "action" | "revision"> & { field: string };
async function seed(automatic: AutomaticView, actions: Action[], legacy?: { payload: unknown; revision: number; provenance?: string }, staleEntity = false, noDecision = false) {
  const id = ++nextId;
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at,classification,personal_revision) VALUES(?,?,'',?,?,100)")
    .bind(id, `https://example.com/reset/${id}`, date, json(automatic)).run();
  if (!noDecision) {
    await env.DB.prepare(`INSERT INTO classification_runs(id,link_id,content_revision,spec_id,spec_hash,target_generation,
      requested_model,policy_version,answers,operation_key,created_at) VALUES(?,?,1,'test','test',1,'test','test','{}',?,?)`)
      .bind(id, id, `run-${id}`, date).run();
    await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
      VALUES(?,?,1,'test','{}',?,?,?)`).bind(id, id, json(automatic), `decision-${id}`, date).run();
  }
  await env.DB.prepare(`INSERT INTO evidence_snapshots(id,link_id,content_revision,content_hash,payload,created_at)
    VALUES(?,?,1,'hash','{}',?)`).bind(id, id, date).run();
  await env.DB.prepare(`INSERT INTO entity_states(link_id,state,content_revision,entities,updated_at,content_hash,evidence_snapshot_id)
    VALUES(?,'completed_nonempty',1,?,?,?,?)`).bind(id, json(automatic.entities), date, staleEntity ? "mismatch" : "hash", id).run();
  for (const [index, action] of actions.entries()) {
    await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
      VALUES(?,?,?,?,'human',1,?,?,?)`).bind(id, action.field, action.term, action.action, action.revision, `${id}-${index}`, date).run();
  }
  const layered: Override[] = [];
  if (legacy) {
    await env.DB.prepare(`INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at) VALUES(?,?,?,?,?)`)
      .bind(id, json(legacy.payload), legacy.revision, legacy.provenance ?? "legacy_unknown", date).run();
    if (!legacy.provenance || legacy.provenance === "legacy_unknown") {
      const payload = legacy.payload as Record<string, unknown> | null;
      const add = (field: Override["field"], action: Override["action"], term = "") => layered.push({ field, action, term, revision: legacy.revision, source: "legacy_unknown", confirmed: false });
      for (const field of ["topics", "form", "use"] as const) {
        if (payload === null) { add(field, "reset"); continue; }
        if (!(field in payload)) continue;
        add(field, "set_empty");
        const value = field === "topics" ? payload[field] : [payload[field]];
        if (Array.isArray(value)) for (const term of value) if (typeof term === "string" && term) add(field, "accept", term);
      }
    }
  }
  layered.push(...actions.map(action => ({ ...action, field: normalizeField(action.field)!, source: "human" as const, confirmed: true })));
  const baseline = noDecision ? { ...EMPTY_AUTOMATIC, topics: automatic.topics, form: automatic.form, use: automatic.use } : { ...automatic };
  baseline.entities = staleEntity ? [] : automatic.entities;
  const expected = effectiveView(baseline, layered);
  const old = structuredClone(expected);
  // Freeze the old defect independently of the new resolver: term resets did
  // not clear the empty bit set by the last non-term-reset action.
  for (const field of OVERRIDE_FIELDS) {
    const ordered = layered.filter(a => a.field === field).sort((a, b) => a.revision - b.revision);
    const last = ordered.filter(a => !(a.action === "reset" && a.term !== "")).at(-1);
    if (last?.action === "set_empty") {
      if (field === "form" || field === "use") old[field] = "";
      else old[field] = [];
      if (field !== "entities") old.empty[field] = true;
    }
  }
  await env.DB.prepare(`INSERT INTO current_projections(link_id,content_revision,effective,updated_at) VALUES(?,1,?,?)`)
    .bind(id, json({ ...old, projected: !noDecision, stale: false }), date).run();
  await env.DB.prepare(`INSERT INTO link_selections_v2(link_id,taxonomy_version,topics,content_functions,carriers,affordances,form,use,provenance,revised_at)
    VALUES(?,'test',?,?,?,?,?,?,'{"keep":"audit"}',?)`)
    .bind(id, json(old.topics), json(old.content_functions), json(old.carriers), json(old.affordances), old.form, old.use, date).run();
  await env.DB.prepare("UPDATE links SET curation=?,curation_projection_epoch=curation_projection_epoch+1 WHERE id=?")
    .bind(old.reviewed ? json({ topics: old.topics.slice(0, 3), form: old.form, use: old.use, keep: "metadata" }) : null, id).run();
  return { id, expected, noDecision };
}

async function immutable() {
  const result: Record<string, unknown> = {};
  for (const table of ["curation_overrides", "curation_events", "legacy_curation_history", "classification_runs", "classification_decisions", "entity_states", "evidence_snapshots"]) {
    result[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY link_id`).all()).results;
  }
  result.links = (await env.DB.prepare("SELECT id,personal_revision,content_revision,classification,note,why,curation_status FROM links ORDER BY id").all()).results;
  return result;
}

async function checkUpgrade(cases: Awaited<ReturnType<typeof seed>>[]) {
  const before = await immutable();
  // 0030 adds an explicitly empty provenance column to legacy entity rows.
  // Every previously stored field must still remain byte-for-byte unchanged.
  before.entity_states=(before.entity_states as Record<string,unknown>[]).map(row=>({...row,observations:"[]"}));
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await immutable()).toEqual(before);
  for (const { id, expected, noDecision } of cases) {
    const current = await readSelectionSnapshot(dbEnv as Parameters<typeof readSelectionSnapshot>[0], id);
    expect(current!.view, `canonical ${id}`).toEqual(expected);
    const cache = await env.DB.prepare("SELECT effective,updated_at FROM current_projections WHERE link_id=?").bind(id).first<{ effective: string; updated_at: string }>();
    expect(JSON.parse(cache!.effective), `cache ${id}`).toEqual({ ...expected, projected: !noDecision, stale: false });
    expect(cache!.updated_at).toBe(date);
    const selection = await env.DB.prepare("SELECT * FROM link_selections_v2 WHERE link_id=?").bind(id).first<Record<string, any>>();
    for (const field of ["topics", "content_functions", "carriers", "affordances"] as const) expect(JSON.parse(selection![field]), `${id} ${field}`).toEqual(expected[field]);
    expect(selection).toMatchObject({ form: expected.form, use: expected.use, provenance: '{"keep":"audit"}', revised_at: date });
    const curation = await env.DB.prepare("SELECT curation FROM links WHERE id=?").bind(id).first<string | null>("curation");
    expect(curation && JSON.parse(curation), `legacy ${id}`).toEqual(expected.reviewed ? { topics: expected.topics.slice(0, 3), form: expected.form, use: expected.use, keep: "metadata" } : null);
    const entities = await env.DB.prepare("SELECT term FROM effective_entity_terms WHERE link_id=? ORDER BY term").bind(id).all<{ term: string }>();
    expect(entities.results.map(r => r.term), `search ${id}`).toEqual([...expected.entities].sort());
  }
  expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_reset_%'").all()).results).toEqual([]);
  for (const [query, matches] of [
    ["topic=llm", (v: AutomaticView) => v.topics.slice(0, 3).includes("llm")],
    ["form=method", (v: AutomaticView) => v.form === "method"],
    ["use=try", (v: AutomaticView) => v.use === "try"],
    ["q=AcmeEntity", (v: AutomaticView) => v.entities.includes("AcmeEntity")]
  ] as const) {
    const response = await worker.fetch(new Request(`https://test.example/api/enrichment/jobs?limit=100&${query}`, {
      headers: { Authorization: "Bearer internal" }
    }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: number }> };
    expect(body.items.map(item => item.id), query).toEqual(cases.filter(c => matches(c.expected)).map(c => c.id).sort((a, b) => b - a));
  }
  // Migration ledger makes repeated application a no-op.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await immutable()).toEqual(before);
}

it("0024 upgrades all shared override histories without rewriting their source records", async () => {
  await beforeUpgrade();
  const cases = [];
  for (const vector of vectors.vectors) cases.push(await seed(vector.automatic, vector.overrides as Action[]));
  await checkUpgrade(cases);
}, 30_000);

it("0024 repairs legacy empty barriers, noncurrent entities and absent terms while preserving later decisions", async () => {
  await beforeUpgrade();
  const automatic = { ...EMPTY_AUTOMATIC, topics: ["llm", "eng", "eval", "design"], form: "method", use: "try", entities: ["AcmeEntity", "OtherEntity"] };
  const actions: Action[] = [{ field: "topics", action: "reset", term: "llm", revision: 2 }];
  const cases = [];
  for (const payload of [{ topics: [] }, { topics: [null, ""] }, { topics: ["eng"] }, {}, null]) {
    for (const revision of [1, 2, 3]) cases.push(await seed(automatic, actions, { payload, revision }, false, true));
  }
  for (const field of OVERRIDE_FIELDS) {
    const terms = automatic[field];
    const term = Array.isArray(terms) ? terms[0] ?? "absent" : terms;
    const empty: Action = { field, action: "set_empty", term: "", revision: 1 };
    const resetTerm: Action = { field, action: "reset", term, revision: 2 };
    for (const suffix of [[], [{ field, action: "set_empty", term: "", revision: 3 }], [{ field, action: "reset", term: "", revision: 3 }], [{ field, action: "reject", term, revision: 3 }], [{ field, action: "accept", term, revision: 3 }]] as Action[][]) {
      cases.push(await seed(automatic, [empty, resetTerm, ...suffix]));
    }
    cases.push(await seed(automatic, [empty, { ...resetTerm, term: "absent" }]));
  }
  cases.push(await seed(automatic, [{ field: "entities", action: "set_empty", term: "", revision: 1 }, { field: "entities", action: "reset", term: "AcmeEntity", revision: 2 }], undefined, true));
  cases.push(await seed(automatic, ["llm", "eng", "eval", "design"].map((term, i) => ({ field: "topics", action: "reset", term, revision: i + 2 })), { payload: { topics: [] }, revision: 1 }));
  cases.push(await seed(automatic, actions, { payload: { topics: [] }, revision: 3, provenance: "ambiguous_projection" }));
  // Old singular fields and insertion order must obey the canonical revision
  // order, including a reset whose ID precedes the earlier empty event.
  cases.push(await seed(automatic, [{ field: "entities", action: "reset", term: "AcmeEntity", revision: 2 }, { field: "entities", action: "set_empty", term: "", revision: 1 }]));
  cases.push(await seed(automatic, [{ field: "entity", action: "set_empty", term: "", revision: 1 }, { field: "entity", action: "reset", term: "AcmeEntity", revision: 2 }] as Action[]));
  await checkUpgrade(cases);
}, 30_000);
