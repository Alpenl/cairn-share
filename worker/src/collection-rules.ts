import type { Env } from "./index";
import { managedCatalog, catalogTerm } from "./tag-catalog";
export type CollectionRule={id:string;rule_enabled:number;rule_mode:string;rule_tags:string;rule_after_id:number;rule_revision:number;revision:number};
export type RuleTag={ref:string;field:string;term:string;kind:"system"|"custom"};
export async function resolveRuleTags(env:Env,refs:unknown,active=true):Promise<RuleTag[]|null> {
 if(!Array.isArray(refs)||refs.length>20||new Set(refs).size!==refs.length||refs.some(x=>typeof x!=="string"))return null;
 const {catalog}=await managedCatalog(env),out:RuleTag[]=[];
 for(const ref of refs) {
  const s=ref.match(/^system\/(topics|resource_kinds|content_functions|carriers|affordances|forms|uses|form|use)\/([a-z][a-z0-9_]{0,39})$/);
  if(s){const dimension=s[1]==='form'?'forms':s[1]==='use'?'uses':s[1],term=catalogTerm(catalog,dimension,s[2]);if(!term||(active&&(!term.active||term.deprecated)))return null;out.push({ref,field:dimension==='forms'?'form':dimension==='uses'?'use':dimension,term:s[2],kind:'system'});continue;}
  const c=ref.match(/^custom\/default\/([0-9a-f-]{36})$/);if(!c)return null;
  const tag=await env.DB.prepare("SELECT status FROM custom_tags WHERE id=? AND owner_id='default'").bind(c[1]).first<{status:string}>();if(!tag||(active&&tag.status!=='active'))return null;
  out.push({ref,field:'custom',term:c[1],kind:'custom'});
 }
 return out;
}
// The same predicate powers preview, backfill and final admission. It observes
// final indexed memberships, after the enclosing human/classification transaction.
const tagMatchSQL=(link:string)=>`(json_extract(t.value,'$.kind')='system' AND EXISTS(SELECT 1 FROM effective_tag_memberships e WHERE e.link_id=${link} AND e.field=json_extract(t.value,'$.field') AND e.term=json_extract(t.value,'$.term')))
 OR (json_extract(t.value,'$.kind')='custom' AND EXISTS(SELECT 1 FROM custom_tag_links a JOIN custom_tags c ON c.id=a.tag_id WHERE a.link_id=${link} AND a.tag_id=json_extract(t.value,'$.term') AND c.owner_id='default' AND c.status='active'))`;
export const ruleMatchSQL=(link='l.id')=>`(SELECT COUNT(*) FROM json_each(?) t WHERE ${tagMatchSQL(link)}) >= ?`;
export const matchedRefsSQL=(link='l.id')=>`(SELECT json_group_array(json_extract(t.value,'$.ref')) FROM json_each(?) t WHERE ${tagMatchSQL(link)})`;
export async function previewRule(env:Env,rule:CollectionRule) {
 const tags=await resolveRuleTags(env,JSON.parse(rule.rule_tags));
 if(!tags?.length)return {items:[],has_more:false,rule_valid:false};
 const rows=await env.DB.prepare(`SELECT l.id,COALESCE(NULLIF(l.ai_title,''),l.url) AS title FROM links l WHERE l.curation_status<>'drop'
 AND NOT EXISTS(SELECT 1 FROM collection_items i WHERE i.collection_id=? AND i.link_id=l.id)
 AND NOT EXISTS(SELECT 1 FROM collection_rule_exclusions x WHERE x.collection_id=? AND x.link_id=l.id)
 AND ${ruleMatchSQL()} ORDER BY l.id LIMIT 101`).bind(rule.id,rule.id,JSON.stringify(tags),rule.rule_mode==='all'?tags.length:1).all();
 return {items:rows.results.slice(0,100),has_more:rows.results.length>100,rule_valid:true};
}
/** Indexed, bounded, restartable. No model and no source/network retrieval. */
export async function drainCollectionRules(env:Env,limit=20):Promise<number> {
 const queued=await env.DB.prepare('SELECT link_id,revision FROM collection_rule_queue ORDER BY link_id LIMIT ?').bind(limit).all<{link_id:number;revision:number}>();
 if(!queued.results.length)return 0;
 const rules=await env.DB.prepare('SELECT id,revision,rule_enabled,rule_tags,rule_mode,rule_after_id,rule_revision FROM collections WHERE rule_enabled=1 AND deleted=0 AND archived=0').all<CollectionRule>();
 const resolved=await Promise.all(rules.results.map(async rule=>({rule,tags:await resolveRuleTags(env,JSON.parse(rule.rule_tags))})));
 for(const q of queued.results){
  const stamp=new Date().toISOString(),operation=crypto.randomUUID(),statements:D1PreparedStatement[]=[];
  for(const {rule,tags} of resolved){if(!tags?.length||q.link_id<=rule.rule_after_id)continue;
   statements.push(env.DB.prepare(`INSERT INTO collection_items(collection_id,link_id,position,added_at,origin,matched_tags,rule_operation)
    SELECT ?,l.id,COALESCE((SELECT MAX(position)+1 FROM collection_items WHERE collection_id=?),0),?,'rule',${matchedRefsSQL()},?
    FROM links l WHERE l.id=? AND l.curation_status<>'drop' AND ${ruleMatchSQL()}
    AND EXISTS(SELECT 1 FROM collection_rule_queue WHERE link_id=? AND revision=?)
    AND EXISTS(SELECT 1 FROM collections WHERE id=? AND rule_revision=? AND rule_enabled=1 AND deleted=0 AND archived=0)
    AND NOT EXISTS(SELECT 1 FROM collection_rule_exclusions x WHERE x.collection_id=? AND x.link_id=l.id)
    AND (SELECT COUNT(*) FROM collection_items WHERE collection_id=?)<1000 ON CONFLICT(collection_id,link_id) DO NOTHING`)
    .bind(rule.id,rule.id,stamp,JSON.stringify(tags),operation,q.link_id,JSON.stringify(tags),rule.rule_mode==='all'?tags.length:1,q.link_id,q.revision,rule.id,rule.rule_revision,rule.id,rule.id));
   statements.push(env.DB.prepare("UPDATE collections SET revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM collection_items WHERE collection_id=? AND link_id=? AND rule_operation=?)").bind(new Date().toISOString(),rule.id,rule.id,q.link_id,operation));
  }
  statements.push(env.DB.prepare("INSERT INTO cache_metadata(key,value,updated_at) SELECT 'links_generation',1,? WHERE EXISTS(SELECT 1 FROM collection_items WHERE link_id=? AND rule_operation=?) ON CONFLICT(key) DO UPDATE SET value=cache_metadata.value+1,updated_at=excluded.updated_at").bind(new Date().toISOString(),q.link_id,operation));
  // A rule edited after the read must not discard work evaluated under an old
  // definition; retain the entry for the next pass if any observed rule changed.
  const versions=JSON.stringify(rules.results.map(r=>({id:r.id,revision:r.rule_revision})));
  statements.push(env.DB.prepare(`DELETE FROM collection_rule_queue WHERE link_id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM json_each(?) v JOIN collections c ON c.id=json_extract(v.value,'$.id') WHERE c.rule_revision<>json_extract(v.value,'$.revision') AND NOT EXISTS(SELECT 1 FROM collection_items i WHERE i.collection_id=c.id AND i.link_id=? AND i.rule_operation=?))`).bind(q.link_id,q.revision,versions,q.link_id,operation));
  await env.DB.batch(statements);
 }
 return queued.results.length;
}
