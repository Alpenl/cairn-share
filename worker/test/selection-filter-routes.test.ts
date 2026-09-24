import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
async function request(path: string, body?: unknown, token = "internal") {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
async function fixture() {
  const ids: number[] = [];
  for (const name of ["first", "second"]) {
    const created = await request("links", { url: `https://example.com/filter/${name}` }, "app");
    expect(created.status).toBe(201);
    ids.push((await created.json() as { id: number }).id);
  }
  for (const [index, fields] of [
    { topics: ["llm", "eng", "eval", "design"], content_functions: ["method"], carriers: ["single"], affordances: ["practice"] },
    { topics: ["eng"], content_functions: ["data"], carriers: ["external_article"], affordances: ["background"] }
  ].entries()) {
    for (const [field, terms] of Object.entries(fields)) for (const term of terms) {
      const response = await request(`v2/links/${ids[index]}/overrides`, { operation_key: `${index}-${field}-${term}`, field, term, action: "accept" });
      expect(response.status).toBe(200);
    }
  }
  return ids;
}

for (const [route, token] of [["links", "app"], ["enrichment/jobs", "internal"]]) {
  it.each([
    ["topic=design", "fourth topic"],
    ["content_functions=method,data&carriers=single&affordances=practice", "OR within dimensions and AND across dimensions"]
  ])(`${route} applies %s (%s) to the effective selection`, async query => {
    const [first] = await fixture();
    const response = await request(`${route}?${query}`, undefined, token);
    expect(response.status).toBe(200);
    const result = await response.json() as { items: Array<{ id: number }> };
    expect(result.items.map(row => row.id)).toEqual([first]);
  });

  it(`${route} distinguishes absent entity runs from failed runs`, async () => {
    await fixture();
    const response = await request(`${route}?entity_state=failed`, undefined, token);
    expect(response.status).toBe(200);
    expect((await response.json() as { items: unknown[] }).items).toEqual([]);
  });

  it(`${route} rejects invalid v2 filters instead of broadening a query`, async () => {
    await fixture();
    const response = await request(`${route}?content_functions=not_a_term`, undefined, token);
    expect(response.status).toBe(400);
  });
}

it('different dimension and entity filters have separate cache entries and repeat reads hit', async () => {
  const [first,second]=await fixture();
  for(const [query,ids] of [
    ['content_functions=method',[first]],['content_functions=data',[second]],
    ['topics=design',[first]],['topics=eng',[second,first]],['topic=design&topics=eng',[second,first]],
    ['carriers=single',[first]],['carriers=external_article',[second]],
    ['affordances=practice',[first]],['affordances=background',[second]],
    ['entity_state=failed',[]],['entity_state=not_run',[second,first]]
  ] as const) {
    const response=await request(`links?${query}`,undefined,'app');
    expect(response.headers.get('X-Cairn-Cache'),query).toBe('MISS');
    expect((await response.json() as {items:Array<{id:number}>}).items.map(row=>row.id),query).toEqual(ids);
    expect((await request(`links?${query}`,undefined,'app')).headers.get('X-Cairn-Cache'),query).toBe('HIT');
  }
});
it('counts reflect effective filters but not pagination or the status facet', async () => {
  const [first,second]=await fixture();
  for (const [query,total,ids] of [
    ['content_functions=method',1,[first]],
    ['content_functions=method&status=pending',1,[]],
    ['topics=eng&limit=1',2,[second]],
    [`topics=eng&limit=1&before_id=${second}`,2,[first]],
    [`topics=eng&before_id=${first}`,2,[]],
    ['entity_state=failed',0,[]]
  ] as const) {
    const response=await request(`enrichment/jobs?${query}`);
    expect(response.status).toBe(200);
    const result=await response.json() as {items:Array<{id:number}>;counts:{total:number;unsupported:number}};
    expect(result.items.map(row=>row.id),query).toEqual(ids);
    expect(result.counts.total,query).toBe(total);
    expect(result.counts.unsupported,query).toBe(total);
  }
});
it('filtered cursors count only matching rows and invalid input never reuses cached broad results', async()=>{
  const [first,second]=await fixture();
  await request('links',undefined,'app');
  for(const query of ['content_functions=', 'content_functions=method,', 'content_functions=method,unknown',
    'content_functions=method&content_functions=data', 'topic=llm,eng', 'topics=llm%27%20OR%201=1--',
    'entity_state=', 'entity_state=not_run,unknown','entity_state=failed&entity_state=not_run']) {
    for(const [route,token] of [['links','app'],['enrichment/jobs','internal']])
      expect((await request(`${route}?${query}`,undefined,token)).status,`${route} ${query}`).toBe(400);
  }
  for(const [route,token] of [['links','app'],['enrichment/jobs','internal']]) {
    const page=await (await request(`${route}?topics=eng&limit=1`,undefined,token)).json() as {items:Array<{id:number}>;next_before_id:number|null};
    expect(page.items.map(row=>row.id)).toEqual([second]);expect(page.next_before_id).toBe(second);
    const next=await (await request(`${route}?topics=eng&limit=1&before_id=${page.next_before_id}`,undefined,token)).json() as typeof page;
    expect(next.items.map(row=>row.id)).toEqual([first]);expect(next.next_before_id).toBeNull();
    const limited=await (await request(`${route}?content_functions=method&limit=1`,undefined,token)).json() as typeof page;
    expect(limited.items.map(row=>row.id)).toEqual([first]);expect(limited.next_before_id).toBeNull();
  }
});

it('entity filters follow the independent snapshot state while human corrections leave that state unchanged', async()=>{
  const created=await request('links',{url:'https://example.com/entity-filter'},'app');
  const {id}=await created.json() as {id:number};
  const evidence=async(text:string)=>{
    expect((await request(`v2/links/${id}/evidence`,{snapshot:{blocks:[{id:'primary',role:'primary',text}],retrieval:'manual',fetched_at:'2026-09-23T00:00:00Z',truncation:{truncated:false}}})).status).toBe(200);
    const result=await (await request(`v2/links/${id}/evidence`)).json() as {id:number;content_revision:number;content_hash:string};
    return {evidence_snapshot_id:result.id,content_revision:result.content_revision,content_hash:result.content_hash};
  };
  const check=async(expected:string)=>{
    const detail=await (await request(`bookmarks/${id}/v2-selection?include_state=1`,undefined,'app')).json() as {state:{entities:{status:string}}};
    expect(detail.state.entities.status).toBe(expected);
    for(const state of ['not_run','failed','completed_empty','completed_nonempty','stale']) {
      for(const [route,token] of [['links','app'],['enrichment/jobs','internal']]) {
        const response=await request(`${route}?entity_state=${state}`,undefined,token);
        expect(response.status).toBe(200);
        expect((await response.json() as {items:Array<{id:number}>}).items.map(row=>row.id),`${route} ${state}`).toEqual(state===expected?[id]:[]);
      }
    }
  };
  await check('not_run');
  const identity=await evidence('first source');
  for(const state of ['failed','completed_empty','completed_nonempty']) {
    expect((await request(`v2/links/${id}/entity-state`,{...identity,operation_key:state,state,entities:state==='completed_nonempty'?['AcmeEntity']:[]})).status).toBe(200);
    await check(state);
  }
  expect((await request(`v2/links/${id}/entities`,{operation_key:'human-entity',action:'accept',term:'HumanEntity'})).status).toBe(200);
  await check('completed_nonempty');
  const newer=await evidence('new source');
  await check('stale');
  expect((await request(`v2/links/${id}/entity-state`,{...newer,operation_key:'new-failed',state:'failed',entities:[]})).status).toBe(200);
  await check('failed');
  const view=await (await request(`v2/links/${id}/entities`)).json() as {entities:string[]};
  expect(view.entities).toEqual(['HumanEntity']);
},15_000);

it('authorized filtering does not read deliberately stale projection values',async()=>{
  const [first]=await fixture();
  await env.DB.prepare(`UPDATE link_selections_v2 SET topics='["agents"]',content_functions='["data"]' WHERE link_id=?`).bind(first).run();
  await env.DB.prepare(`UPDATE current_projections SET effective='{}' WHERE link_id=?`).bind(first).run();
  for(const [route,token] of [['links','app'],['enrichment/jobs','internal']]) {
    const response=await request(`${route}?topics=design&content_functions=method`,undefined,token);
    expect(response.status).toBe(200);
    expect((await response.json() as {items:Array<{id:number}>}).items.map(row=>row.id)).toEqual([first]);
    expect((await request(`${route}?topics=design`,undefined,'invalid')).status).toBe(401);
  }
  expect((await request('enrichment/jobs?topics=design',undefined,'app')).status).toBe(401);
});

it('real decision and override writes invalidate filter caches while retaining legal v1 projection',async()=>{
  const created=await request('links',{url:'https://example.com/decision-filter'},'app');
  const {id}=await created.json() as {id:number};
  expect((await request('v2/question-specs',{spec_id:'filter-spec',spec_version:1,questions:{}})).status).toBe(200);
  const spec=await (await request('v2/question-specs/filter-spec')).json() as {spec_hash:string};
  const runResponse=await request(`v2/links/${id}/runs`,{
    operation_key:'filter-run',spec_id:'filter-spec',spec_hash:spec.spec_hash,content_revision:1,target_generation:0,
    policy_version:'jev-policy-v2',policy:{version:'jev-policy-v2',calibrated:false,topic_accept:0.8,topic_reject:0.2,choice_accept:0.65,choice_margin:0.15,max_display_topics:3,max_effective_topics:64},
    requested_model:'jev-latest',resolved_model:'jev-1.13.0',answers:{},usage:{},coverage:'complete'
  });
  expect(runResponse.status).toBe(200);
  const {run}=await runResponse.json() as {run:{id:number}};
  const automatic={topics:['llm','eng','eval','design'],content_functions:['method','data'],carriers:['single'],affordances:['practice'],form:'method',use:'try',entities:[]};
  const decide=async(key:string,topics:string[])=>expect((await request(`v2/links/${id}/decisions`,{
    operation_key:key,run_ids:[run.id],policy_version:'jev-policy-v2',spec_id:'filter-spec',requested_model:'jev-latest',automatic:{...automatic,topics},content_revision:1
  })).status).toBe(200);
  await decide('four-topics',automatic.topics);
  const read=async(query:string,expected:boolean)=>{
    for(const [route,token] of [['links','app'],['enrichment/jobs','internal']]) {
      const response=await request(`${route}?${query}`,undefined,token);
      expect(response.status).toBe(200);
      expect((await response.json() as {items:Array<{id:number}>}).items.map(row=>row.id),query).toEqual(expected?[id]:[]);
    }
  };
  await read('topic=design&content_functions=method,data&carriers=single&affordances=practice',true);
  const old=await (await request(`links/${id}?include=enrichment`,undefined,'app')).json() as {enrichment:{classification:{topics:string[]}}};
  expect(old.enrichment.classification.topics).toHaveLength(3);
  await decide('one-topic',['eng']);
  await read('topic=design&content_functions=method,data&carriers=single&affordances=practice',false);
  for(const [index,field,term,action,query,expected] of [
    [0,'topics','design','accept','topic=design',true],
    [1,'topics','design','reject','topic=design',false],
    [2,'topics','design','reset','topic=design',false],
    [3,'topics','','set_empty','topic=eng',false],
    [4,'topics','eng','reset','topic=eng',true],
    [5,'carriers','external_article','accept','carriers=external_article',true],
    [6,'carriers','external_article','reject','carriers=single,external_article',false],
    [7,'carriers','external_article','reset','carriers=single',true]
  ] as const) {
    const body={operation_key:`filter-human-${index}`,field,term,action};
    expect((await request(`v2/links/${id}/overrides`,body)).status).toBe(200);
    await read(query,expected);
    expect((await request(`v2/links/${id}/overrides`,body)).status).toBe(200);
    await read(query,expected);
  }
},15_000);

it('confirms explicitly negotiated filters without changing old shapes or sharing their cache entry',async()=>{
  await fixture();
  for(const [route,token] of [['links','app'],['enrichment/jobs','internal']]) {
    const old=await request(`${route}?topics=eng`,undefined,token);
    expect(await old.json()).not.toHaveProperty('filter_contract_version');
    const confirmed=await request(`${route}?topics=eng&filter_contract_version=1`,undefined,token);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toHaveProperty('filter_contract_version',1);
    if(route==='links') expect(confirmed.headers.get('X-Cairn-Cache')).toBe('MISS');
    for(const value of ['', '2', '1&filter_contract_version=1'])
      expect((await request(`${route}?topics=eng&filter_contract_version=${value}`,undefined,token)).status).toBe(400);
  }
});
