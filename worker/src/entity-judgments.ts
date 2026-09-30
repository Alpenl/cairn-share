import { canonicalJSON } from "./domain";

type ObjectValue=Record<string,unknown>;
export type EntityCandidate={surface:string;start:number;end:number;block_id:string;source_url?:string;kind:string};
export type EntityBlock={id:string;text:string;role?:string;url?:string};
const object=(value:unknown):value is ObjectValue=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const string=(value:unknown,max:number):value is string=>typeof value==="string"&&value.trim().length>0&&Array.from(value).length<=max;
const probability=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1;
const roles=["relevant","incidental","none","unknown"];
function consistentOptions(groups:ObjectValue[][]):boolean {
 const definitions=new Map<string,string>(),owners=new Map<string,string>();
 for(const options of groups)for(const option of options){
  const entity=option.entity as ObjectValue,id=String(entity.id),definition=canonicalJSON(entity);
  if(definitions.has(id)&&definitions.get(id)!==definition)return false;definitions.set(id,definition);
  for(const identifier of entity.identifiers as string[]){const key=identityURL(identifier);if(owners.has(key)&&owners.get(key)!==id)return false;owners.set(key,id);}
 }
 return true;
}
function identityURL(raw:unknown):string {
 if(typeof raw!=="string"||raw.length>2048||/[\s\\]/u.test(raw))return "";
 try{const u=new URL(raw);if(!["http:","https:"].includes(u.protocol)||u.username||u.password)return "";
 const match=raw.match(/^(https?:\/\/)([^/\?#]+)([^#]*)(?:#.*)?$/);return match?match[1]+match[2].toLowerCase()+match[3]:"";}catch{return "";}
}

export function validEntityCandidate(c:unknown,blocks:EntityBlock[],links:string[]):c is EntityCandidate {
 if(!object(c)||!string(c.surface,2048)||typeof c.block_id!=="string"||!Number.isSafeInteger(c.start)||!Number.isSafeInteger(c.end))return false;
 if(c.kind==="link")return c.source_url===c.surface&&links.includes(c.surface)&&c.block_id===""&&c.start===0&&c.end===0;
 const block=blocks.find(v=>v.id===c.block_id);
 return c.kind==="surface"&&c.source_url===undefined&&Boolean(block)&&Number(c.start)>=0&&Number(c.end)>Number(c.start)&&Number(c.end)<=Array.from(block!.text).length&&Array.from(block!.text).slice(Number(c.start),Number(c.end)).join("")===c.surface;
}

function validOption(option:unknown,candidate:EntityCandidate,blocks:EntityBlock[]):option is ObjectValue {
 if(!object(option)||!object(option.entity)||!Array.isArray(option.evidence)||option.evidence.length<1||option.evidence.length>32)return false;
 const e=option.entity;
 if(typeof e.id!=="string"||! /^[a-z][a-z0-9._-]{0,63}$/.test(e.id)||!string(e.label,120)||!["person","organization","product","project","place"].includes(String(e.kind))||!Array.isArray(e.aliases)||e.aliases.length>16||!e.aliases.every(v=>string(v,120))||!Array.isArray(e.identifiers)||e.identifiers.length<1||e.identifiers.length>8||!e.identifiers.every(v=>identityURL(v)))return false;
 if(candidate.kind!=="link"&&![e.label,...e.aliases].some(v=>String(v).toLowerCase()===candidate.surface.trim().toLowerCase()))return false;
 const block=blocks.find(v=>v.id===candidate.block_id);
 const urls=block?.text.match(/https?:\/\/[^\s<>"'()\[\]]+/g)?.map(v=>identityURL(v.replace(/[.,;!?]+$/,"")))??[];
 return option.evidence.every(v=>{
  if(!object(v)||typeof v.identifier!=="string"||!(e.identifiers as unknown[]).includes(v.identifier))return false;
  const normalized=identityURL(v.identifier);
  if(candidate.kind==="link")return v.source==="stored_link"&&v.block_id===""&&identityURL(candidate.source_url)===normalized;
  return block&&v.block_id===block.id&&((v.source==="block_url"&&identityURL(block.url)===normalized)||(v.source==="block_text"&&urls.includes(normalized)));
 });
}

// The V2 request retains the original material plus a finite controlled set.
// A same-name catalog entry without an identifier in this occurrence's block
// cannot even become a canonical option.
export function validEntityV2State(state:unknown,candidates:EntityCandidate[],blocks:EntityBlock[]):boolean {
 if(!object(state)||state.entity_protocol!==2||!string(state.catalog_version,80)||canonicalJSON(state.entity_candidates)!==canonicalJSON(candidates)||!Array.isArray(state.canonical_options)||state.canonical_options.length!==candidates.length)return false;
 return state.canonical_options.every((options,i)=>Array.isArray(options)&&options.length<=8&&options.every(o=>validOption(o,candidates[i],blocks))&&new Set(options.map(o=>((o as ObjectValue).entity as ObjectValue).id)).size===options.length)&&consistentOptions(state.canonical_options as ObjectValue[][])&&new Set(candidates.map(c=>canonicalJSON(c))).size===candidates.length;
}

export function entityChoiceOptions(state:ObjectValue,index:number):string[] {
 const options=(state.canonical_options as ObjectValue[][])[index];
 return ["none","unknown",...options.map(o=>"id:"+(o.entity as ObjectValue).id)];
}

export function validEntityV2Questions(questions:unknown,state:ObjectValue,candidates:EntityCandidate[]):boolean {
 if(!object(questions))return false;
 const expected:Record<string,string[]>={};
 for(let i=0;i<candidates.length;i++) {
  expected[`entity_${i}`]=roles;
  if((state.canonical_options as unknown[][])[i].length)expected[`canonical_${i}`]=entityChoiceOptions(state,i);
 }
 if(Object.keys(questions).length!==Object.keys(expected).length)return false;
 return Object.entries(expected).every(([id,options])=>{
  const q=questions[id];return object(q)&&q.type==="choice"&&object(q.criteria)&&canonicalJSON(Object.keys(q.criteria).sort())===canonicalJSON([...options].sort());
 });
}

export function validEntityChoice(answer:unknown,options:string[]):answer is ObjectValue {
 if(!object(answer)||Object.keys(answer).length!==4||answer.type!=="choice"||typeof answer.choice!=="string"||!options.includes(answer.choice)||!probability(answer.confidence)||!object(answer.probabilities)||Object.keys(answer.probabilities).length!==options.length)return false;
 const distribution=answer.probabilities;
 return options.every(k=>probability(distribution[k]))&&Math.abs(options.reduce((sum,k)=>sum+Number(distribution[k]),0)-1)<=0.01+1e-12;
}

export function validTypedEntityAnswers(value:unknown,questions:unknown):boolean {
 if(!object(value)||!object(questions)||Object.keys(value).length!==Object.keys(questions).length)return false;
 return Object.entries(questions).every(([id,q])=>{
  const answer=value[id];if(!object(q)||!object(answer))return false;
  if(q.type==="noul")return Object.keys(answer).length===2&&answer.type==="noul"&&probability(answer.noul);
  return q.type==="choice"&&object(q.criteria)&&validEntityChoice(answer,Object.keys(q.criteria));
 });
}

// Persist the full bounded options and typed judgments with each source span,
// independently of the short-lived cache. Recompute selected output fields so
// callers cannot attach an unrelated canonical ID to a valid answer.
export function validEntityObservations(value:unknown,entities:string[],blocks:EntityBlock[],links:string[]):boolean {
 if(!Array.isArray(value)||value.length>40)return false;
 const surfaces=new Set<string>(),occurrences=new Set<string>();let version="";
 for(const observation of value) {
  if(!object(observation)||!validEntityCandidate(observation.candidate,blocks,links)||!string(observation.catalog_version,80)||!Array.isArray(observation.canonical_options)||observation.canonical_options.length>8||!observation.canonical_options.every(o=>validOption(o,observation.candidate as EntityCandidate,blocks)))return false;
  if(version&&version!==observation.catalog_version)return false;version=observation.catalog_version;
  const candidate=observation.candidate,key=canonicalJSON(candidate);if(occurrences.has(key))return false;occurrences.add(key);
  if(!validEntityChoice(observation.relevance,roles))return false;
  const relevance=observation.relevance,selected=String(relevance.choice),distribution=relevance.probabilities as ObjectValue;
  const decision=Number(distribution[selected])>=0.8?selected:"unknown";
  let canonicalState="unknown",canonicalID="",canonicalLabel="",canonicalKind="",evidence:unknown[]=[];
  const options=observation.canonical_options as ObjectValue[];
  if(options.length) {
   if(!validEntityChoice(observation.canonical,["none","unknown",...options.map(o=>"id:"+(o.entity as ObjectValue).id)]))return false;
   const raw=observation.canonical,choice=String(raw.choice);
   if(Number((raw.probabilities as ObjectValue)[choice])>=0.8) {
    if(choice==="none"||choice==="unknown")canonicalState=choice;
    for(const option of options) {const e=option.entity as ObjectValue;if(choice==="id:"+e.id){canonicalState="matched";canonicalID=String(e.id);canonicalLabel=String(e.label);canonicalKind=String(e.kind);evidence=option.evidence as unknown[];}}
   }
  }else if(observation.canonical!==undefined)return false;
  if(decision==="none"||decision==="unknown"){canonicalState=decision;canonicalID="";canonicalLabel="";canonicalKind="";evidence=[];}
  if(observation.decision!==decision||observation.canonical_state!==canonicalState||(observation.canonical_id??"")!==canonicalID||(observation.canonical_label??"")!==canonicalLabel||(observation.canonical_kind??"")!==canonicalKind||canonicalJSON(observation.canonical_evidence)!==canonicalJSON(evidence))return false;
  if(decision==="relevant")surfaces.add(candidate.surface);
 }
 return consistentOptions(value.map(o=>o.canonical_options))&&canonicalJSON([...surfaces].sort())===canonicalJSON([...entities].sort());
}
