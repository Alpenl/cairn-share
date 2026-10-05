import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { bookmarkFilters } from "../src/index";

const boundary = env.TEST_MIGRATIONS.findIndex(m => m.name.startsWith("0052_"));
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, boundary)); });
async function migrate() { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(boundary)); }
async function seed(id: number, body = "") {
  await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text) VALUES(?,?,'','t',?)")
    .bind(id, `https://example.test/${id}`, body).run();
}
function grams(text: string): string[] {
  const bytes = new TextEncoder().encode(text.replace(/[A-Z]/g, c => c.toLowerCase()));
  return [...new Set(Array.from({ length: Math.max(0, bytes.length - 1) }, (_, i) =>
    bytes[i].toString(16).padStart(2, "0") + bytes[i + 1].toString(16).padStart(2, "0")))].map(s => s.toUpperCase()).sort();
}
async function read(sql: string) { return (await env.DB.prepare(sql).all()).results; }
async function assertIndex() {
  const docs = await env.DB.prepare("SELECT link_id,document FROM bookmark_search_documents ORDER BY link_id").all<{link_id:number,document:string}>();
  expect(docs.results).toEqual(await read("SELECT link_id,document FROM canonical_bookmark_search_documents ORDER BY link_id"));
  for (const {link_id,document} of docs.results) {
    const actual = await env.DB.prepare("SELECT gram FROM bookmark_search_grams WHERE link_id=? ORDER BY gram").bind(link_id).all<{gram:string}>();
    expect(actual.results.map(r => r.gram)).toEqual(grams(document));
  }
  expect(await read("SELECT gram,link_id FROM bookmark_search_grams ORDER BY gram,link_id"))
    .toEqual(await read("SELECT DISTINCT gram,link_id FROM bookmark_search_field_grams ORDER BY gram,link_id"));
  expect(await read("SELECT gram,link_count FROM bookmark_search_gram_counts ORDER BY gram"))
    .toEqual(await read("SELECT gram,COUNT(*) AS link_count FROM bookmark_search_grams GROUP BY gram ORDER BY gram"));
  expect(await read("PRAGMA foreign_key_check")).toEqual([]);
}

it("backfills without changing any old business table or byte-gram and preserves empty/LF/NUL/UTF-8 boundaries", async () => {
  for (let id = 1; id <= 5; id++) await seed(id);
  await env.DB.prepare("UPDATE links SET url='X',note=char(10),ai_title=char(0)||'É😀',summary='甲乙'||char(10),original_text='A'||char(0)||'B',why='%',classification=? WHERE id=1")
    .bind(JSON.stringify({why_suggestion:"_\nZ",entities:"尾😀"})).run();
  await env.DB.prepare("UPDATE links SET url='X',note='Y',classification=? WHERE id=2").bind('{"entities":""}').run();
  await env.DB.prepare("UPDATE links SET url='X',note='',original_text='',classification=NULL WHERE id=3").run();
  await env.DB.prepare("UPDATE links SET url='X'||char(0),note=char(0),summary='中文',classification=? WHERE id=4")
    .bind(JSON.stringify({entities:"\n"})).run();
  await env.DB.prepare("INSERT INTO curation_overrides(link_id,field,term,action,source,revision,operation_key,created_at) VALUES(5,'entities','人工实体','accept','human',1,'before','t')").run();
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_*' AND name!='d1_migrations' ORDER BY name").all<{name:string}>();
  const old = new Map<string,unknown[]>();
  for (const {name} of tables.results) old.set(name, await read(`SELECT * FROM "${name}" ORDER BY 1`));
  await migrate();
  for (const [name, rows] of old) expect(await read(`SELECT * FROM "${name}" ORDER BY 1`), name).toEqual(name==="links" ? rows.map(row=>({...row as object,url_identity:null,last_capture_id:null})) : name==="classification_targets" ? rows.map(row=>({...row as object,new_items_only:0})) : rows);
  await assertIndex();
  // A field boundary shift may leave the same composite document. The next
  // changed document still refreshes field ownership without false candidates.
  await env.DB.prepare("UPDATE links SET note='Y'||char(10),ai_title='Z' WHERE id=2").run();
  await env.DB.prepare("UPDATE links SET note='Y',ai_title=char(10)||'Z' WHERE id=2").run();
  await assertIndex();
  await env.DB.prepare("UPDATE links SET why='follow-up' WHERE id=2").run();
  await assertIndex();
  for (const q of ["中文", "尾😀", "B", "É", "_%", "A\0missing", "人工实体"]) {
    const filter = bookmarkFilters(new URL("https://test"), q); if (filter instanceof Response) throw new Error("bad query");
    const legacyClauses = filter.clauses.filter(c => !c.includes("bookmark_search_grams"));
    const optimized = await env.DB.prepare(`SELECT id FROM links WHERE ${filter.clauses.join(" AND ")} ORDER BY id`).bind(...filter.bindings).all();
    const legacy = await env.DB.prepare(`SELECT id FROM links WHERE ${legacyClauses.join(" AND ")} ORDER BY id`)
      .bind(...filter.bindings.slice(filter.clauses[0].includes("bookmark_search_grams") ? 1 : 0)).all();
    expect(optimized.results,q).toEqual(legacy.results);
  }
});

it("only changes short-field gram differences and keeps all shared posting/frequency rows untouched", async () => {
  const body = ("shared alphabet ab 中文正文😀\n".repeat(4500)).slice(0,100000);
  await seed(1, body); await migrate();
  await env.DB.prepare("UPDATE links SET note='shared old note ab' WHERE id=1").run();
  const before = new Set((await env.DB.prepare("SELECT gram FROM bookmark_search_grams WHERE link_id=1").all<{gram:string}>()).results.map(r=>r.gram));
  const original = await read("SELECT * FROM bookmark_search_field_grams WHERE field='original_text' ORDER BY gram");
  await env.DB.exec(`CREATE TABLE search_write_audit(kind TEXT,field TEXT,gram TEXT);
    CREATE TRIGGER audit_field AFTER UPDATE ON bookmark_search_fields BEGIN INSERT INTO search_write_audit VALUES('field',NEW.field,NULL); END;
    CREATE TRIGGER audit_insert AFTER INSERT ON bookmark_search_grams BEGIN INSERT INTO search_write_audit VALUES('insert',NULL,NEW.gram); END;
    CREATE TRIGGER audit_delete AFTER DELETE ON bookmark_search_grams BEGIN INSERT INTO search_write_audit VALUES('delete',NULL,OLD.gram); END;`);
  const result = await env.DB.prepare("UPDATE links SET note='shared new 短注 ab' WHERE id=1").run();
  expect(await read("SELECT field FROM search_write_audit WHERE kind='field'")).toEqual([{field:"note"}]);
  expect(await read("SELECT * FROM bookmark_search_field_grams WHERE field='original_text' ORDER BY gram")).toEqual(original);
  const after = new Set((await env.DB.prepare("SELECT gram FROM bookmark_search_grams WHERE link_id=1").all<{gram:string}>()).results.map(r=>r.gram));
  const touched = await env.DB.prepare("SELECT kind,gram FROM search_write_audit WHERE gram IS NOT NULL").all<{kind:string,gram:string}>();
  for (const {kind,gram} of touched.results) {
    expect(before.has(gram) && after.has(gram), `${kind}:${gram}`).toBe(false);
  }
  expect(result.meta.rows_written).toBeLessThan(160);
  await assertIndex();
  await env.DB.prepare("DELETE FROM search_write_audit").run();
  await env.DB.prepare("UPDATE links SET note=upper(note) WHERE id=1").run();
  expect(await read("SELECT * FROM search_write_audit WHERE gram IS NOT NULL")).toEqual([]);
  await assertIndex();
},30_000);

it("handles source/entity UPSERT and REPLACE, rejects, barriers, staleness and bulk cascading deletion", async () => {
  for (let id=1;id<=3;id++) await seed(id,"old source 中文");
  await migrate();
  await env.DB.prepare("INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,completeness,truncated,created_at) VALUES(1,1,'h','{}','complete',0,'t')").run();
  const sid = await env.DB.prepare("SELECT id FROM evidence_snapshots WHERE link_id=1").first<number>("id");
  for (let n=0;n<3;n++) {
    await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text) VALUES(1,'https://example.test/1','','t',?) ON CONFLICT(id) DO UPDATE SET original_text=excluded.original_text")
      .bind(`new${n} 写真 source`).run();
    await env.DB.prepare("INSERT INTO entity_states(link_id,state,content_revision,entities,content_hash,evidence_snapshot_id,updated_at) VALUES(1,'completed_nonempty',1,?,'h',?,'t') ON CONFLICT(link_id) DO UPDATE SET entities=excluded.entities")
      .bind(JSON.stringify([`Entity${n}`,"SharedEntity"]),sid).run();
    await assertIndex();
  }
  for (const [revision,action,term] of [[1,"reject","SharedEntity"],[2,"reset","SharedEntity"],[3,"set_empty",""],[4,"reset",""]] as const) {
    await env.DB.prepare("INSERT INTO curation_overrides(link_id,field,term,action,source,revision,operation_key,created_at) VALUES(1,'entities',?,?,'human',?,?, 't')")
      .bind(term,action,revision,`op${revision}`).run();
    expect(await read("SELECT link_id,term FROM effective_entity_memberships ORDER BY link_id,term"))
      .toEqual(await read("SELECT link_id,term FROM effective_entity_terms ORDER BY link_id,term"));
    await assertIndex();
  }
  await env.DB.prepare("UPDATE links SET content_revision=2 WHERE id=1").run();
  expect(await read("SELECT term FROM effective_entity_memberships WHERE link_id=1")).toEqual([]); await assertIndex();
  await env.DB.prepare("INSERT OR REPLACE INTO entity_states(link_id,state,entities,updated_at) VALUES(1,'failed','[]','replace')").run(); await assertIndex();
  await env.DB.prepare("UPDATE OR REPLACE links SET note='bulk 笔记',why='purpose' WHERE id IN(1,2,3)").run(); await assertIndex();
  await env.DB.prepare("INSERT OR REPLACE INTO links(id,url,note,created_at,original_text) VALUES(2,'https://replacement.test/2','replacement','t','FreshUnicode😀')").run(); await assertIndex();
  await env.DB.prepare("DELETE FROM links WHERE id IN(1,2)").run(); await assertIndex();
  await env.DB.prepare("DELETE FROM links").run();
  for (const table of ["bookmark_search_documents","bookmark_search_fields","bookmark_search_field_grams","bookmark_search_grams","bookmark_search_gram_counts"])
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"),table).toBe(0);
});

it("rolls back source, field references, postings and frequencies if an incremental write fails", async () => {
  await seed(1,"atomic body 中文"); await migrate();
  const tables=["links","bookmark_search_documents","bookmark_search_fields","bookmark_search_field_grams","bookmark_search_grams","bookmark_search_gram_counts"];
  const before = new Map<string,unknown[]>(); for (const t of tables) before.set(t,await read(`SELECT * FROM ${t} ORDER BY 1,2`));
  await env.DB.exec("CREATE TRIGGER fail_field_gram BEFORE INSERT ON bookmark_search_field_grams WHEN NEW.field='note' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
  await expect(env.DB.prepare("UPDATE links SET note='zqx987新内容' WHERE id=1").run()).rejects.toThrow("fixture write failure");
  for (const [t, rows] of before) expect(await read(`SELECT * FROM ${t} ORDER BY 1,2`),t).toEqual(rows);
  await assertIndex();
});
