import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "vitest";
import { selectionFilters } from "../src/selection-filter";
import worker from "../src/index";

it('queries the full collection through indexed histories instead of a bounded candidate prefix',async()=>{
  await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  // 1,200 saved items / 9,600 actions. Only the OLDEST item matches all four
  // dimensions. This is a deterministic local scale sample, not a production
  // latency benchmark or proof for arbitrarily large collections.
  await env.DB.prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<1200)
    INSERT INTO links(id,url,note,created_at,classification)
    SELECT id,'https://example.com/scale/'||id,'','2026-09-23T00:00:00Z','{"topics":["llm"],"form":"method","use":"try"}' FROM n`).run();
  await env.DB.prepare(`WITH actions(field,term,action,revision) AS (VALUES
    ('topics','llm','reject',1),('topics','llm','reset',2),('content_functions','method','accept',3),
    ('carriers','single','accept',4),('carriers','external_article','accept',5),('carriers','external_article','reset',6),
    ('affordances','practice','accept',7),('topics','eng','accept',8))
    INSERT INTO curation_overrides(link_id,field,term,action,revision,source,confirmed,operation_key,created_at)
    SELECT l.id,a.field,a.term,a.action,a.revision,'human',1,l.id||'-'||a.revision,'2026-09-23T00:00:00Z' FROM links l CROSS JOIN actions a`).run();
  await env.DB.prepare("UPDATE curation_overrides SET term='design' WHERE link_id=1 AND revision=8").run();
  const filter=selectionFilters(new URLSearchParams('topics=design&content_functions=method&carriers=single&affordances=practice'))!;
  const query=`SELECT id FROM links WHERE ${filter.clauses.join(' AND ')} ORDER BY id DESC LIMIT 2`;
  const plan=await env.DB.prepare('EXPLAIN QUERY PLAN '+query).bind(...filter.bindings).all<{detail:string}>();
  const details=plan.results.map(row=>row.detail);
  expect(details.some(text=>text.includes('SEARCH curation_overrides USING INDEX'))).toBe(true);
  expect(details.some(text=>text.includes('SEARCH legacy_curation_history USING'))).toBe(true);
  expect(details.some(text=>text.includes('SEARCH classification_decisions USING INDEX'))).toBe(true);
  const result=await env.DB.prepare(query).bind(...filter.bindings).all<{id:number}>();
  expect(result.results.map(row=>row.id)).toEqual([1]);
  console.log('B05 local scale',JSON.stringify({links:1200,actions:9600,meta:result.meta,plan:details}));
  const response=await worker.fetch(new Request('https://test.example/api/enrichment/jobs?topics=design&content_functions=method&carriers=single&affordances=practice&limit=1',
    {headers:{Authorization:'Bearer internal'}}),{DB:env.DB,ENRICHMENT_IMAGES:env.ENRICHMENT_IMAGES,CAIRN_ENRICHER_TOKEN:'internal',CAIRN_API_TOKEN:'app'});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({items:[{id:1}],next_before_id:null,counts:{total:1}});
},30_000);
