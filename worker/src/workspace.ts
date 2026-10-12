import type { Env } from "./index";
import { displayedCatalog } from "./tag-catalog";
import { indexedSearchCandidate } from "./search-index";
import { readSelectionSnapshot } from "./selection-state";
import { tagPayload } from "./tag-system";

const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const parse = <T>(value: unknown, fallback: T): T =>
  typeof value === "string" ? JSON.parse(value) : fallback;
const uuid = /^[a-f0-9-]{36}$/;
const failed = "enrichment_status IN ('failed','exhausted')";
const tagRefs = `(SELECT json_group_array(ref) FROM (
 SELECT 'system/'||field||'/'||term ref FROM effective_tag_memberships WHERE link_id=links.id ORDER BY field,position,term))`;
const customRefs = `(SELECT json_group_array('custom/default/'||t.id) FROM custom_tag_links a JOIN custom_tags t ON t.id=a.tag_id WHERE a.link_id=links.id AND t.owner_id='default')`;
const memberships = `(SELECT json_group_object(i.collection_id,i.note) FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE i.link_id=links.id AND c.deleted=0)`;
const summaryColumns = `id,url,created_at,ai_title,original_language,substr(summary,1,1200) summary,enrichment_status,app_body_revision,personal_revision,
 CASE WHEN length(COALESCE(translated_text,''))>0 THEN 1 ELSE 0 END translated,
 ${tagRefs} tag_refs,${customRefs} custom_refs,${memberships} memberships`;
type Row = Record<string, unknown> & {
  id: number;
  url: string;
  created_at: string;
};
function article(row: Row, detail = false) {
  const body = detail
    ? String(
        row.formatted_content || row.translated_text || row.original_text || "",
      )
    : "";
  const language = String(row.original_language ?? "");
  return {
    id: row.id,
    kind: "article",
    title: row.ai_title || row.url,
    source: new URL(row.url).hostname,
    url: row.url,
    date: row.created_at.slice(0, 10),
    lang: language.startsWith("zh")
      ? "zh"
      : language.startsWith("en")
        ? row.translated || row.translated_text
          ? "en-translated"
          : "en"
        : "unknown",
    summary: row.summary ?? "",
    body: body.split(/\n\s*\n/).filter(Boolean),
    raw: detail ? (row.original_text ?? "") : "",
    ...(detail
      ? {
          images: parse<Array<{ key: string; content_type: string }>>(
            row.images,
            [],
          ).map((image) => ({
            src: `/api/images/${encodeURIComponent(image.key)}`,
          })),
          media: parse<unknown[]>(row.media, []),
        }
      : {}),
    tags: [
      ...parse<string[]>(row.tag_refs, []),
      ...parse<string[]>(row.custom_refs, []),
    ],
    excluded: [],
    cols: parse<Record<string, string>>(row.memberships, {}),
    links: detail
      ? parse<string[]>(row.related_links, []).map((url) => ({
          label: url,
          url,
        }))
      : [],
    failed: ["failed", "exhausted"].includes(String(row.enrichment_status)),
    bodyRevision: row.app_body_revision,
    personalRevision: row.personal_revision,
  };
}
function query(url: URL) {
  const p = url.searchParams;
  if (
    [...p.keys()].some(
      (k) =>
        ![
          "q",
          "quick",
          "range",
          "today",
          "tags",
          "mode",
          "collection",
          "kind",
          "cursor",
          "limit",
        ].includes(k) || p.getAll(k).length !== 1,
    )
  )
    return null;
  const q = (p.get("q") ?? "").trim(),
    range = p.get("range") ?? "all",
    today = p.get("today") ?? new Date().toISOString().slice(0, 10),
    mode = p.get("mode") ?? "any",
    kind = p.get("kind") ?? "article";
  if (
    q.length > 200 ||
    q.includes("\0") ||
    !["article", "site"].includes(kind) ||
    !["any", "all"].includes(mode) ||
    !["all", "todo"].includes(p.get("quick") ?? "all") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(today) ||
    !Number.isFinite(Date.parse(today)) ||
    new Date(today).toISOString().slice(0, 10) !== today ||
    !/^(all|1|3|7|30|d\d{1,4})$/.test(range)
  )
    return null;
  let tags: unknown;
  try {
    tags = JSON.parse(p.get("tags") ?? "[]");
  } catch {
    return null;
  }
  if (
    !Array.isArray(tags) ||
    tags.length > 50 ||
    tags.some(
      (x) =>
        typeof x !== "string" ||
        x.length > 200 ||
        !/^(system\/(topics|resource_kinds|content_functions|carriers|affordances|form|use)\/[^/]+|custom\/default\/[a-f0-9-]{36})$/.test(
          x,
        ),
    )
  )
    return null;
  const limit = Number(p.get("limit") ?? 40),
    cursor = Number(p.get("cursor") ?? 0),
    collection = p.get("collection");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    (collection && !uuid.test(collection))
  )
    return null;
  const rangeBindings: (string | number)[] = [];
  let dateWhere = "1";
  if (range !== "all") {
    const ago = range.startsWith("d")
      ? Number(range.slice(1))
      : Number(range) - 1;
    const start = new Date(Date.parse(today) - ago * 86400000)
      .toISOString()
      .slice(0, 10);
    const end = new Date(
      Date.parse(range.startsWith("d") ? start : today) + 86400000,
    )
      .toISOString()
      .slice(0, 10);
    dateWhere = "created_at>=? AND created_at<?";
    rangeBindings.push(start, end);
  }
  const clauses = [dateWhere],
    bindings = [...rangeBindings];
  if (kind === "site") clauses.push("0");
  if (p.get("quick") === "todo") clauses.push(failed);
  if (collection) {
    clauses.push(
      "id IN (SELECT link_id FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE c.id=? AND c.deleted=0)",
    );
    bindings.push(collection);
  }
  if (q) {
    const candidate = indexedSearchCandidate([q]);
    if (candidate) {
      clauses.push(candidate.clause);
      bindings.push(candidate.binding);
    }
    clauses.push(
      "EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=links.id AND instr(lower(d.document),lower(?))>0)",
    );
    bindings.push(q);
  }
  if (tags.length) {
    const refs = [...new Set(tags as string[])].map((ref) => {
      const [type, field, term] = ref.split("/");
      return { type, field, term };
    });
    clauses.push(`links.id IN(SELECT link_id FROM(
    SELECT t.link_id,'system/'||t.field||'/'||t.term ref FROM json_each(?) r JOIN effective_tag_memberships t ON t.field=json_extract(r.value,'$.field') AND t.term=json_extract(r.value,'$.term')
    UNION ALL SELECT a.link_id,'custom/default/'||a.tag_id ref FROM json_each(?) r JOIN custom_tag_links a ON a.tag_id=r.value JOIN custom_tags t ON t.id=a.tag_id WHERE t.owner_id='default'
  ) GROUP BY link_id HAVING COUNT(DISTINCT ref)>=?)`);
    bindings.push(
      JSON.stringify(refs.filter((r) => r.type === "system")),
      JSON.stringify(
        refs.filter((r) => r.type === "custom").map((r) => r.term),
      ),
      mode === "all" ? refs.length : 1,
    );
  }
  return {
    where: clauses.join(" AND "),
    bindings,
    dateWhere: kind === "site" ? "0" : dateWhere,
    rangeBindings: kind === "site" ? [] : rangeBindings,
    limit,
    cursor,
    today,
    collection,
  };
}
// Each request returns only a bounded page. Counts, search, tag/collection joins,
// date grouping and dashboard statistics execute next to D1, never in the browser.
export async function workspace(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    id = url.pathname.match(/\/workspace\/(\d+)$/)?.[1];
  if (id) return detail(env, Number(id), url);
  const member = url.pathname.match(
    /\/workspace\/collections\/([a-f0-9-]{36})$/,
  )?.[1];
  if (member) return members(env, member, url);
  const q = query(url);
  if (!q) return reply({ error: "invalid_query" }, 400);
  const started = performance.now();
  const make = (sql: string, bindings: (string | number)[] = []) =>
    env.DB.prepare(sql).bind(...bindings);
  const order = q.collection
    ? "(SELECT position FROM collection_items WHERE collection_id=? AND link_id=links.id),id"
    : "id DESC";
  const pageWhere = q.cursor
    ? q.collection
      ? " AND (SELECT position FROM collection_items WHERE collection_id=? AND link_id=links.id)>(SELECT position FROM collection_items WHERE collection_id=? AND link_id=?)"
      : " AND id<?"
    : "";
  const pageBindings = [
    ...q.bindings,
    ...(q.cursor
      ? q.collection
        ? [q.collection, q.collection, q.cursor]
        : [q.cursor]
      : []),
    ...(q.collection ? [q.collection] : []),
    q.limit + 1,
  ];
  const [catalog, result] = await Promise.all([
    displayedCatalog(env),
    env.DB.batch([
      make(
        `SELECT ${summaryColumns} FROM links WHERE ${q.where}${pageWhere} ORDER BY ${order} LIMIT ?`,
        pageBindings,
      ),
      make(`SELECT COUNT(*) n FROM links WHERE ${q.where}`, q.bindings),
      make(
        `SELECT COUNT(*) total,COALESCE(SUM(${failed}),0) failed FROM links`,
      ),
      make(
        `SELECT (SELECT id FROM links WHERE ${q.dateWhere} ORDER BY created_at DESC,id DESC LIMIT 1) latest_id,COUNT(*) saved,COALESCE(SUM((SELECT COUNT(*) FROM effective_tag_memberships t WHERE t.link_id=links.id)+(SELECT COUNT(*) FROM custom_tag_links a WHERE a.link_id=links.id)),0) tags,COALESCE(SUM(EXISTS(SELECT 1 FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE i.link_id=links.id AND c.deleted=0)),0) placed FROM links WHERE ${q.dateWhere}`,
        [...q.rangeBindings, ...q.rangeBindings],
      ),
      make(
        "SELECT substr(created_at,1,10) day,COUNT(*) n FROM links WHERE created_at>=date(?,'-370 days') AND created_at<date(?,'+1 day') GROUP BY substr(created_at,1,10)",
        [q.today, q.today],
      ),
      make(
        `SELECT ${summaryColumns} FROM links WHERE ${q.dateWhere} AND NOT (${failed}) ORDER BY created_at DESC,id DESC LIMIT 12`,
        q.rangeBindings,
      ),
      make(
        `SELECT ${summaryColumns} FROM links WHERE ${failed} ORDER BY id DESC LIMIT 12`,
      ),
      make(
        `SELECT c.*,(SELECT COUNT(*) FROM collection_items i WHERE i.collection_id=c.id) item_count,
   (SELECT COUNT(*) FROM collection_items i JOIN links ON links.id=i.link_id WHERE i.collection_id=c.id AND ${q.dateWhere}) range_count FROM collections c ORDER BY c.pinned DESC,c.created_at`,
        q.rangeBindings,
      ),
      make(
        "SELECT 'system/'||field||'/'||term ref,COUNT(*) n FROM effective_tag_memberships GROUP BY field,term UNION ALL SELECT 'custom/default/'||tag_id ref,COUNT(*) n FROM custom_tag_links a JOIN custom_tags t ON t.id=a.tag_id WHERE t.owner_id='default' GROUP BY tag_id",
      ),
      make("SELECT * FROM custom_dimensions ORDER BY rowid"),
      make(
        "SELECT *, 'custom/default/'||id tag_ref FROM custom_tags WHERE owner_id='default' AND NOT EXISTS(SELECT 1 FROM custom_tag_operations d WHERE d.tag_id=custom_tags.id AND d.action='delete') ORDER BY label,id",
      ),
    ]),
  ]);
  const results = result as D1Result<Record<string, unknown>>[];
  const rows = results[0].results as Row[],
    items = rows.slice(0, q.limit).map((row) => article(row));
  const events = (results[5].results as Row[])
    .flatMap((row) => {
      const a = article(row);
      return [
        ...Object.keys(a.cols).map((collection) => ({
          id: a.id,
          title: a.title,
          date: a.date,
          type: "collection",
          collection,
          count: 0,
        })),
        {
          id: a.id,
          title: a.title,
          date: a.date,
          type: "tags",
          collection: null,
          count: a.tags.length,
        },
      ];
    })
    .slice(0, 12);
  const response = reply({
    version: 1,
    catalog: {
      ...catalog,
      dimensions: results[9].results,
      custom_tags: results[10].results,
    },
    collections: results[7].results,
    items,
    total: results[1].results[0].n,
    next_cursor: rows.length > q.limit ? items.at(-1)!.id : null,
    facets: {
      ...results[2].results[0],
      tags: Object.fromEntries(
        results[8].results.map((x) => [String(x.ref), Number(x.n)]),
      ),
    },
    overview: {
      ...results[3].results[0],
      days: results[4].results,
      events,
      failed: (results[6].results as Row[]).map((row) => article(row)),
      latest_id: results[3].results[0].latest_id ?? null,
    },
  });
  response.headers.set(
    "Server-Timing",
    `workspace;dur=${(performance.now() - started).toFixed(1)}, sql;desc="bounded page + aggregates"`,
  );
  return response;
}
async function detail(env: Env, id: number, url: URL) {
  const known = Number(url.searchParams.get("body_revision") ?? -1);
  if (
    !Number.isSafeInteger(known) ||
    known < -1 ||
    [...url.searchParams.keys()].some((k) => k !== "body_revision") ||
    url.searchParams.getAll("body_revision").length > 1
  )
    return reply({ error: "invalid_query" }, 400);
  const [snapshot, cols] = await Promise.all([
    readSelectionSnapshot(env, id, true, known, true, true, true),
    env.DB.prepare(
      "SELECT i.collection_id,i.note FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE i.link_id=? AND c.deleted=0",
    )
      .bind(id)
      .all<{ collection_id: string; note: string }>(),
  ]);
  if (!snapshot) return reply({ error: "not_found" }, 404);
  const state = await tagPayload(env, id, snapshot);
  const refs = Object.entries(state!.selection).flatMap(([field, value]) =>
    [
      "topics",
      "resource_kinds",
      "content_functions",
      "carriers",
      "affordances",
      "form",
      "use",
    ].includes(field)
      ? (Array.isArray(value)
          ? value
          : typeof value === "string" && value
            ? [value]
            : []
        ).map((term) => `system/${field}/${term}`)
      : [],
  );
  const row = {
    ...snapshot.link,
    tag_refs: JSON.stringify(refs),
    custom_refs: JSON.stringify(state!.custom_tags.map((t) => t.tag_ref)),
    memberships: JSON.stringify(
      Object.fromEntries(cols.results.map((c) => [c.collection_id, c.note])),
    ),
  } as unknown as Row;
  return reply({
    article: article(row, true),
    tag_state: state,
    body_unchanged: known === row.app_body_revision,
  });
}
async function members(env: Env, id: string, url: URL) {
  const cursor = Number(url.searchParams.get("cursor") ?? 0),
    limit = 40;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    [...url.searchParams.keys()].some((k) => k !== "cursor")
  )
    return reply({ error: "invalid_query" }, 400);
  const [c, rows] = await Promise.all([
    env.DB.prepare("SELECT revision,deleted FROM collections WHERE id=?")
      .bind(id)
      .first(),
    env.DB.prepare(
      `SELECT ${summaryColumns},(SELECT position FROM collection_items WHERE collection_id=? AND link_id=links.id) position FROM links WHERE id IN(SELECT link_id FROM collection_items WHERE collection_id=? AND position>?) ORDER BY position,id LIMIT ?`,
    )
      .bind(
        id,
        id,
        cursor
          ? ((await env.DB.prepare(
              "SELECT position FROM collection_items WHERE collection_id=? AND link_id=?",
            )
              .bind(id, cursor)
              .first<number>("position")) ?? -1)
          : -1,
        limit + 1,
      )
      .all<Row>(),
  ]);
  if (!c || c.deleted) return reply({ error: "not_found" }, 404);
  const page = rows.results.slice(0, limit);
  return reply({
    revision: c.revision,
    items: page.map((row) => article(row)),
    next_cursor: rows.results.length > limit ? page.at(-1)!.id : null,
    next_id: rows.results[limit]?.id ?? null,
  });
}
