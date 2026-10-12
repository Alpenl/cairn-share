import type { Env } from "./index";
import { managedCatalog, catalogTerm } from "./tag-catalog";
export type CollectionRule={id:string;rule_enabled:number;rule_mode:string;rule_tags:string;rule_after_id:number;rule_revision:number;revision:number;
 rule_exclude_tags?:string;rule_admission?:string;rule_confirmed_only?:number};
export type RuleTag={ref:string;field:string;term:string;kind:"system"|"custom"};
export const RULE_TAG_LIMIT=20;
export async function resolveRuleTags(env:Env,refs:unknown,active=true):Promise<RuleTag[]|null> {
 if(!Array.isArray(refs)||refs.length>RULE_TAG_LIMIT||new Set(refs).size!==refs.length||refs.some(x=>typeof x!=="string"))return null;
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
// Human confirmation of a system tag is an accepted human override for that
// term (singular legacy field names included). Personal tags are always set by
// a person, so they count as confirmed.
const singular=(f:string)=>`CASE ${f} WHEN 'topics' THEN 'topic' WHEN 'content_functions' THEN 'content_function' WHEN 'carriers' THEN 'carrier' WHEN 'affordances' THEN 'affordance' WHEN 'resource_kinds' THEN 'resource_kind' ELSE ${f} END`;
const confirmedSQL=(link:string)=>`EXISTS(SELECT 1 FROM curation_overrides o WHERE o.link_id=${link} AND o.term=json_extract(t.value,'$.term') AND o.action='accept' AND o.source='human' AND o.confirmed=1
  AND (o.field=json_extract(t.value,'$.field') OR o.field=${singular("json_extract(t.value,'$.field')")}))`;
// The same predicate powers preview, backfill and final admission. It observes
// final indexed memberships, after the enclosing human/classification transaction.
const tagMatchSQL=(link:string,confirmed=false)=>`((json_extract(t.value,'$.kind')='system' AND EXISTS(SELECT 1 FROM effective_tag_memberships e WHERE e.link_id=${link} AND e.field=json_extract(t.value,'$.field') AND e.term=json_extract(t.value,'$.term'))${confirmed?` AND ${confirmedSQL(link)}`:""})
 OR (json_extract(t.value,'$.kind')='custom' AND EXISTS(SELECT 1 FROM custom_tag_links a JOIN custom_tags c ON c.id=a.tag_id WHERE a.link_id=${link} AND a.tag_id=json_extract(t.value,'$.term') AND c.owner_id='default' AND c.status='active'${confirmed?" AND a.origin='human'":""})))`;
/** Bindings: tags JSON, required count. Kept for callers that only know v1 rules. */
export const ruleMatchSQL=(link='l.id')=>`(SELECT COUNT(*) FROM json_each(?) t WHERE ${tagMatchSQL(link)}) >= ?`;
export const matchedRefsSQL=(link='l.id',confirmed=false)=>`(SELECT json_group_array(json_extract(t.value,'$.ref')) FROM json_each(?) t WHERE ${tagMatchSQL(link,confirmed)})`;
/** Full v2 predicate. Bindings, in order: tags JSON, required count, exclusion JSON. */
export const ruleV2SQL=(link='l.id',confirmed=false)=>`((SELECT COUNT(*) FROM json_each(?) t WHERE ${tagMatchSQL(link,confirmed)}) >= ? AND NOT EXISTS(SELECT 1 FROM json_each(?) t WHERE ${tagMatchSQL(link)}))`;
export type ResolvedRule={tags:RuleTag[];exclude:RuleTag[];need:number;confirmed:boolean;review:boolean};
export async function resolveRule(env:Env,rule:CollectionRule):Promise<ResolvedRule|null>{
 const tags=await resolveRuleTags(env,JSON.parse(rule.rule_tags));
 // An archived exclusion tag can no longer be attached, so it is simply inert.
 const exclude=(await resolveRuleTags(env,JSON.parse(rule.rule_exclude_tags??'[]'),false))??[];
 if(!tags?.length)return null;
 return {tags,exclude,need:rule.rule_mode==='all'?tags.length:1,confirmed:rule.rule_confirmed_only===1,review:rule.rule_admission==='review'};
}
export const ruleBindings=(r:ResolvedRule)=>[JSON.stringify(r.tags),r.need,JSON.stringify(r.exclude)];
const eligibleSQL=`l.curation_status<>'drop'
 AND NOT EXISTS(SELECT 1 FROM collection_items i WHERE i.collection_id=? AND i.link_id=l.id)
 AND NOT EXISTS(SELECT 1 FROM collection_rule_exclusions x WHERE x.collection_id=? AND x.link_id=l.id)`;
export async function previewRule(env:Env,rule:CollectionRule) {
 const r=await resolveRule(env,rule);
 if(!r)return {items:[],has_more:false,rule_valid:false,counts:{would_add:0,pending:0,ignored:0,excluded_by_tag:0}};
 const [rows,excludedByTag,candidates]=await env.DB.batch([
  env.DB.prepare(`SELECT l.id,COALESCE(NULLIF(l.ai_title,''),l.url) AS title,${matchedRefsSQL('l.id',r.confirmed)} AS matched_tags,
   (SELECT status FROM collection_rule_candidates k WHERE k.collection_id=? AND k.link_id=l.id) AS candidate_status
   FROM links l WHERE ${eligibleSQL} AND ${ruleV2SQL('l.id',r.confirmed)} ORDER BY l.id LIMIT 101`)
   .bind(JSON.stringify(r.tags),rule.id,rule.id,rule.id,...ruleBindings(r)),
  env.DB.prepare(`SELECT COUNT(*) AS n FROM links l WHERE ${eligibleSQL} AND (SELECT COUNT(*) FROM json_each(?) t WHERE ${tagMatchSQL('l.id',r.confirmed)})>=? AND EXISTS(SELECT 1 FROM json_each(?) t WHERE ${tagMatchSQL('l.id')})`)
   .bind(rule.id,rule.id,...ruleBindings(r)),
  env.DB.prepare("SELECT status,COUNT(*) AS n FROM collection_rule_candidates WHERE collection_id=? GROUP BY status").bind(rule.id)
 ]);
 const items=(rows.results as Array<{id:number;title:string;matched_tags:string;candidate_status:string|null}>).map(x=>({id:x.id,title:x.title,matched_tags:JSON.parse(x.matched_tags),candidate_status:x.candidate_status}));
 const by=Object.fromEntries((candidates.results as Array<{status:string;n:number}>).map(x=>[x.status,x.n]));
 return {items:items.slice(0,100),has_more:items.length>100,rule_valid:true,
  counts:{would_add:items.filter(x=>x.candidate_status!=='ignored').length,pending:by.pending??0,ignored:by.ignored??0,excluded_by_tag:(excludedByTag.results[0] as {n:number}).n}};
}
/** Indexed, bounded, restartable. No model and no source/network retrieval. */
export async function drainCollectionRules(env:Env,limit=20):Promise<number> {
 const queued=await env.DB.prepare('SELECT link_id,revision FROM collection_rule_queue ORDER BY link_id LIMIT ?').bind(limit).all<{link_id:number;revision:number}>();
 if(!queued.results.length)return 0;
 const rules=await env.DB.prepare('SELECT id,revision,rule_enabled,rule_tags,rule_mode,rule_after_id,rule_revision,rule_exclude_tags,rule_admission,rule_confirmed_only FROM collections WHERE rule_enabled=1 AND deleted=0 AND archived=0').all<CollectionRule>();
 const resolved=await Promise.all(rules.results.map(async rule=>({rule,r:await resolveRule(env,rule)})));
 for(const q of queued.results){
  const stamp=new Date().toISOString(),operation=crypto.randomUUID(),statements:D1PreparedStatement[]=[];
  for(const {rule,r} of resolved){if(!r||q.link_id<=rule.rule_after_id)continue;
   const live=`EXISTS(SELECT 1 FROM collection_rule_queue WHERE link_id=? AND revision=?)
    AND EXISTS(SELECT 1 FROM collections WHERE id=? AND rule_revision=? AND rule_enabled=1 AND deleted=0 AND archived=0)`;
   if(r.review){
    // A match waits for review. Ignored or already-decided candidates stay decided.
    statements.push(env.DB.prepare(`INSERT INTO collection_rule_candidates(collection_id,link_id,matched_tags,rule_revision,status,created_at,operation_key)
     SELECT ?,l.id,${matchedRefsSQL('l.id',r.confirmed)},?,'pending',?,? FROM links l WHERE l.id=? AND ${eligibleSQL} AND ${ruleV2SQL('l.id',r.confirmed)} AND ${live}
     ON CONFLICT(collection_id,link_id) DO NOTHING`)
     .bind(rule.id,JSON.stringify(r.tags),rule.rule_revision,stamp,operation,q.link_id,rule.id,rule.id,...ruleBindings(r),q.link_id,q.revision,rule.id,rule.rule_revision));
    // A pending candidate that no longer matches is withdrawn, never auto-ignored.
    statements.push(env.DB.prepare(`DELETE FROM collection_rule_candidates WHERE collection_id=? AND link_id=? AND status='pending' AND operation_key<>?
     AND NOT EXISTS(SELECT 1 FROM links l WHERE l.id=? AND ${ruleV2SQL('l.id',r.confirmed)}) AND ${live}`)
     .bind(rule.id,q.link_id,operation,q.link_id,...ruleBindings(r),q.link_id,q.revision,rule.id,rule.rule_revision));
    statements.push(env.DB.prepare("UPDATE collections SET revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM collection_rule_candidates WHERE collection_id=? AND link_id=? AND operation_key=?)").bind(stamp,rule.id,rule.id,q.link_id,operation));
    continue;
   }
   statements.push(env.DB.prepare(`INSERT INTO collection_items(collection_id,link_id,position,added_at,origin,matched_tags,rule_operation)
    SELECT ?,l.id,COALESCE((SELECT MAX(position)+1 FROM collection_items WHERE collection_id=?),0),?,'rule',${matchedRefsSQL('l.id',r.confirmed)},?
    FROM links l WHERE l.id=? AND l.curation_status<>'drop' AND ${ruleV2SQL('l.id',r.confirmed)} AND ${live}
    AND NOT EXISTS(SELECT 1 FROM collection_rule_exclusions x WHERE x.collection_id=? AND x.link_id=l.id)
    AND (SELECT COUNT(*) FROM collection_items WHERE collection_id=?)<1000 ON CONFLICT(collection_id,link_id) DO NOTHING`)
    .bind(rule.id,rule.id,stamp,JSON.stringify(r.tags),operation,q.link_id,...ruleBindings(r),q.link_id,q.revision,rule.id,rule.rule_revision,rule.id,rule.id));
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
