import {applyD1Migrations,env,reset} from "cloudflare:test";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
const hex=(n:number)=>n.toString(16).padStart(64,"0");
const bindings=()=>({...env,CAIRN_API_TOKEN:"app",CAIRN_ENRICHER_TOKEN:"internal"});
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
async function call(path:string,body?:unknown,method=body===undefined?"GET":"POST",token="internal") {
 return worker.fetch(new Request("https://test/api/"+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),bindings());
}
const choice=(selected:string,options:string[])=>({type:"choice",choice:selected,probabilities:Object.fromEntries(options.map(v=>[v,v===selected?1:0])),confidence:1});
const roles=["relevant","incidental","none","unknown"];
async function fixture(){
 await env.DB.prepare("INSERT INTO links(id,url,note,created_at,original_text,related_links) VALUES(1,'https://example.com/source','','t','Acme','[]')").run();
 const revision=await env.DB.prepare("SELECT content_revision FROM links WHERE id=1").first<number>("content_revision");
 const blocks=[{id:"a",text:"Acme",role:"primary",url:"https://example.com/a"},{id:"b",text:"Acme",role:"external_article",url:"https://example.com/b"},{id:"c",text:"Acme",role:"quoted"}];
 await env.DB.prepare("INSERT INTO evidence_snapshots(id,link_id,content_revision,content_hash,payload,created_at) VALUES(1,1,?,?,?,'t')").bind(revision,hex(9),JSON.stringify({blocks})).run();
 const candidates=blocks.map(b=>({surface:"Acme",start:0,end:4,block_id:b.id,kind:"surface"}));
 const options=blocks.map((b,i)=>i===2?[]:[{entity:{id:"acme-"+b.id,label:"Acme",kind:"project",aliases:[],identifiers:[b.url]},evidence:[{identifier:b.url,block_id:b.id,source:"block_url"}]}]);
 const state={material:blocks.map(b=>({ID:b.id,Text:b.text,role:b.role,...(b.url?{url:b.url}:{})})),stored_links:[],entity_protocol:2,entity_candidates:candidates,canonical_options:options,catalog_version:"fixture-1"};
 const questions:Record<string,unknown>={},answers:Record<string,unknown>={};
 for(let i=0;i<3;i++){
  questions[`entity_${i}`]={type:"choice",criteria:Object.fromEntries(roles.map(v=>[v,v]))};answers[`entity_${i}`]=choice("relevant",roles);
  if(i<2){const values=["none","unknown","id:acme-"+blocks[i].id];questions[`canonical_${i}`]={type:"choice",criteria:Object.fromEntries(values.map(v=>[v,v]))};answers[`canonical_${i}`]=choice(values[2],values);}
 }
 const wire={model:"jev-1.13.0",state,questions};
 const claim={link_id:1,evidence_snapshot_id:1,content_revision:revision,content_hash:hex(9),owner_token:hex(1),spec_hash:hex(3),candidates,request_json:JSON.stringify(wire)};
 const observations=candidates.map((candidate,i)=>({candidate,decision:"relevant",canonical_state:i===2?"unknown":"matched",...(i<2?{canonical_id:"acme-"+blocks[i].id,canonical_label:"Acme",canonical_kind:"project",canonical:answers[`canonical_${i}`]}:{}),canonical_evidence:options[i].map(o=>o.evidence[0]),catalog_version:"fixture-1",canonical_options:options[i],relevance:answers[`entity_${i}`]}));
 const submission={operation_key:"typed-entity",state:"completed_nonempty",entities:["Acme"],content_revision:revision,content_hash:hex(9),evidence_snapshot_id:1,observations};
 return {claim,wire,answers,observations,submission};
}

it("stores different same-name identities and unknown, retains provenance after cache expiry, and respects human/stale results",async()=>{
 const f=await fixture();const response=await call("v2/entity-cache/claim",f.claim);expect(response.status).toBe(200);
 const receipt=await response.json() as {key:string};
 expect((await call(`v2/entity-cache/${receipt.key}/complete`,{owner_token:f.claim.owner_token,status:"completed",answers:f.answers})).status).toBe(200);
 expect((await call("v2/links/1/entity-state",f.submission)).status).toBe(200);expect((await call("v2/links/1/entity-state",f.submission)).status).toBe(200);
 await env.DB.prepare("DELETE FROM entity_cache").run();
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({entities:["Acme"],observations:f.observations,effective_observations:f.observations});
 expect((await call("v2/links/1/entities",{operation_key:"reject-acme",action:"reject",term:"Acme"})).status).toBe(200);
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({entities:[],observations:f.observations,effective_observations:[]});
 expect((await call("v2/links/1/entities",{operation_key:"reset-acme",action:"reset",term:"Acme"})).status).toBe(200);
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({entities:["Acme"],effective_observations:f.observations});
 await env.DB.prepare("UPDATE links SET original_text='Changed' WHERE id=1").run();
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({stale:true,entities:[],observations:f.observations,effective_observations:[]});
 expect((await call("v2/links/1/entity-state",{...f.submission,operation_key:"late-typed"})).status).toBe(409);
});

it("rejects same-name identity without local evidence, injected options and invalid distributions before completion",async()=>{
 const f=await fixture();
 const copied=structuredClone(f.wire);copied.state.canonical_options[2]=copied.state.canonical_options[0];
 expect((await call("v2/entity-cache/claim",{...f.claim,request_json:JSON.stringify(copied)})).status).toBe(400);
 const conflicting=structuredClone(f.wire),extra=structuredClone(conflicting.state.canonical_options[0][0]);extra.entity.id="conflicting-identity";
 conflicting.state.canonical_options[0].push(extra);
 (conflicting.questions.canonical_0 as {criteria:Record<string,string>}).criteria["id:conflicting-identity"]="same identifier under a second ID";
 expect((await call("v2/entity-cache/claim",{...f.claim,request_json:JSON.stringify(conflicting)})).status).toBe(400);
 const r=await(await call("v2/entity-cache/claim",f.claim)).json() as {key:string};
 for(const answer of [choice("outside",["outside","none","unknown"]),{type:"noul",noul:.99},{...choice("id:acme-a",["id:acme-a","none","unknown"]),confidence:2},{...choice("id:acme-a",["id:acme-a","none","unknown"]),probabilities:{"id:acme-a":.2,none:.2,unknown:.2}}]){
  expect((await call(`v2/entity-cache/${r.key}/complete`,{owner_token:f.claim.owner_token,status:"completed",answers:{...f.answers,canonical_0:answer}})).status).toBe(400);
 }
 expect(await env.DB.prepare("SELECT status FROM entity_cache").first("status")).toBe("pending");
});

it("recomputes canonical fields from raw choices and never overwrites a success with failure",async()=>{
 const f=await fixture();
 for(const patch of [{canonical_id:"invented"},{canonical_label:"invented"},{canonical_state:"unknown"},{canonical_evidence:[]},{candidate:{...f.observations[0].candidate,start:1}}]){
  expect((await call("v2/links/1/entity-state",{...f.submission,observations:[{...f.observations[0],...patch},...f.observations.slice(1)]})).status).toBe(400);
 }
 expect((await call("v2/links/1/entity-state",f.submission)).status).toBe(200);
 const legacy={...f.submission,operation_key:"old-consumer",observations:undefined,entities:["OldSurface"]};
 expect(await(await call("v2/links/1/entity-state",legacy)).json()).toMatchObject({status:"ignored_stale"});
 expect(await(await call("v2/links/1/entity-state",{...f.submission,operation_key:"later-failure",state:"failed",entities:[],observations:[]})).json()).toMatchObject({status:"ignored_stale"});
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({state:"completed_nonempty",observations:f.observations});
 expect((await call("links/1",undefined,"DELETE","app")).status).toBe(204);
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM entity_states").first("n")).toBe(0);expect(await env.DB.prepare("SELECT COUNT(*) n FROM entity_operations").first("n")).toBe(0);
});

it("keeps none, unknown and incidental distinguishable inside a completed empty result",async()=>{
 const f=await fixture();
 const observations=f.observations.map((v,i)=>{const decision=["none","unknown","incidental"][i];return {...v,decision,relevance:choice(decision,roles),canonical_state:decision==="incidental"?"unknown":decision,canonical_id:undefined,canonical_label:undefined,canonical_kind:undefined,canonical_evidence:[]};});
 expect((await call("v2/links/1/entity-state",{...f.submission,state:"completed_empty",entities:[],observations})).status).toBe(200);
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({state:"completed_empty",entities:[],observations:observations.map(v=>({decision:v.decision,canonical_state:v.canonical_state}))});
});

it("upgrades legacy entity records with unknown provenance without rewriting source or results",async()=>{
 await reset();const index=env.TEST_MIGRATIONS.findIndex(m=>m.name.startsWith("0030"));expect(index).toBeGreaterThan(0);
 await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,index));
 const f=await fixture();
 await env.DB.prepare("INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,entities,updated_at) VALUES(1,'completed_nonempty',?,?,1,'[\"Acme\"]','t')").bind(f.claim.content_revision,f.claim.content_hash).run();
 const before=await env.DB.prepare("SELECT * FROM entity_states").first();
 const snapshot=await env.DB.prepare("SELECT * FROM evidence_snapshots").all();
 await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(index));
 expect(await env.DB.prepare("SELECT * FROM entity_states").first()).toEqual({...before,observations:"[]"});
 expect((await env.DB.prepare("SELECT * FROM evidence_snapshots").all()).results).toEqual(snapshot.results);
 expect(await(await call("v2/links/1/entities")).json()).toMatchObject({entities:["Acme"],observations:[],effective_observations:[]});
});
