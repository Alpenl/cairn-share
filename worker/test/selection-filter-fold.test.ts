import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { SELECTION_TERMS_SQL } from "../src/selection-filter";
import { readSelectionSnapshot } from "../src/selection-state";
import { EMPTY_AUTOMATIC, type AutomaticView } from "../src/domain";
import vectors from "./fixtures/override-vectors.json";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const date = "2026-09-23T00:00:00Z";
type Action = { field: string; term: string; action: string; revision: number };
const fields = ["topics", "content_functions", "carriers", "affordances", "form", "use"] as const;
async function seed(automatic: AutomaticView, actions: Action[], legacy?: { payload: unknown; revision: number; provenance?: string }, noDecision = false) {
  const result = await env.DB.prepare("INSERT INTO links(url,note,created_at,classification) VALUES(?,'',?,?)")
    .bind(`https://example.com/${crypto.randomUUID()}`, date, JSON.stringify(automatic)).run();
  const id = result.meta.last_row_id;
  if (!noDecision) {
    await env.DB.prepare(`INSERT INTO classification_runs(id,link_id,content_revision,spec_id,spec_hash,target_generation,
      requested_model,policy_version,answers,operation_key,created_at) VALUES(?,?,1,'test','test',1,'test','test','{}',?,?)`)
      .bind(id,id,`run-${id}`,date).run();
    await env.DB.prepare(`INSERT INTO classification_decisions(link_id,run_id,content_revision,policy_version,policy,automatic,operation_key,created_at)
      VALUES(?,?,1,'test','{}',?,?,?)`).bind(id,id,JSON.stringify(automatic),`decision-${id}`,date).run();
  }
  if (legacy) await env.DB.prepare(`INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at) VALUES(?,?,?,?,?)`)
    .bind(id,JSON.stringify(legacy.payload),legacy.revision,legacy.provenance ?? 'legacy_unknown',date).run();
  for (const [index, action] of actions.entries()) await env.DB.prepare(`INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at)
    VALUES(?,?,?,?,'human',1,?,?,?)`).bind(id,action.field,action.term,action.action,action.revision,`${id}-${index}`,date).run();
  return id;
}
async function sqlView(id: number) {
  const result = await env.DB.prepare(`SELECT (SELECT json_group_array(json_object('field',field,'term',term))
    FROM (${SELECTION_TERMS_SQL})) AS terms FROM links WHERE id=?`).bind(id).first<string>('terms');
  const terms = JSON.parse(result!) as Array<{ field: string; term: string }>;
  return Object.fromEntries(fields.map(field => [field,terms.filter(row => row.field === field).map(row => row.term).sort()]));
}
const membership = (view: Pick<AutomaticView, typeof fields[number]>) => Object.fromEntries(fields.map(field => {
  const value = view[field];
  return [field,(typeof value === 'string' ? value ? [value] : [] : value as string[]).slice().sort()];
}));
it('SQL membership agrees with every shared Go/Worker golden vector', async () => {
  for (const vector of vectors.vectors) {
    const id = await seed(vector.automatic as AutomaticView,vector.overrides);
    expect(await sqlView(id),vector.name).toEqual(membership(vector.expected));
  }
}, 30_000);
it('SQL membership follows legacy null/empty/full sets, latest history, aliases and revision/id order', async () => {
  const automatic = { ...EMPTY_AUTOMATIC,topics:['llm','eng'],content_functions:['method'],carriers:['single'],form:'method',use:'try' };
  const actions = [
    {field:'topic',term:'llm',action:'reject',revision:2},
    {field:'topics',term:'llm',action:'reset',revision:4},
    {field:'form',term:'case',action:'accept',revision:3},
    {field:'form',term:'data',action:'accept',revision:3},
    {field:'form',term:'data',action:'reject',revision:3},
    {field:'carrier',term:'external_article',action:'accept',revision:4}
  ];
  for (const payload of [null,{}, {topics:[],form:'',use:''},{topics:['eng'],form:'case'}, {topics:['eng','llm'],form:'method'}, {topics:[1,'eng','',null],form:null}]) {
    for (const revision of [1,3,5]) for (const noDecision of [false,true]) {
      const id = await seed(automatic,actions,{payload,revision},noDecision);
      const snapshot = await readSelectionSnapshot({DB:env.DB} as Parameters<typeof readSelectionSnapshot>[0],id);
      expect(await sqlView(id),JSON.stringify({payload,revision,noDecision})).toEqual(membership(snapshot!.view));
      // Newer known projection is not historical human input; older legacy
      // history must not remain active merely because it has that provenance.
      await env.DB.prepare(`INSERT INTO legacy_curation_history(link_id,payload,revision,provenance,created_at) VALUES(?,'{"topics":["design"]}',8,'human',?)`).bind(id,date).run();
      const latest = await readSelectionSnapshot({DB:env.DB} as Parameters<typeof readSelectionSnapshot>[0],id);
      expect(await sqlView(id)).toEqual(membership(latest!.view));
    }
  }
}, 30_000);
it('SQL membership matches the canonical fold across deterministic mixed histories', async () => {
  let state=92813;
  const random=(max:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state>>>8)%max;};
  for(let sample=0;sample<80;sample++) {
    const actions:Action[]=[];
    for(let index=0;index<24;index++) {
      const field=fields[random(fields.length)];
      const action=['accept','reject','reset','set_empty'][random(4)];
      actions.push({field,term:action==='set_empty'?'':action==='reset'&&random(3)===0?'':['a','b','c'][random(3)],action,revision:random(9)});
    }
    const automatic={topics:['a','b'],content_functions:['b'],carriers:['c'],affordances:['a'],form:'a',use:'b',entities:[]};
    const id=await seed(automatic,actions);
    const snapshot=await readSelectionSnapshot({DB:env.DB} as Parameters<typeof readSelectionSnapshot>[0],id);
    expect(await sqlView(id),`history ${sample}: ${JSON.stringify(actions)}`).toEqual(membership(snapshot!.view));
  }
}, 30_000);
