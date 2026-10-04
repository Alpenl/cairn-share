import Defuddle from "defuddle";
import TurndownService from "turndown";
import {gfm} from "turndown-plugin-gfm";
import DOMPurify from "dompurify";

// Runs in the extensions isolated world; libraries are packaged locally.
export function extractPageWithLibraries(expectedURL, preview=false) {
 if(location.href!==expectedURL)throw new Error("page_changed");
 const isX=/(^|\.)(x|twitter)\.com$/.test(location.hostname),status=location.pathname.match(/\/status\/(\d+)/)?.[1];
 let root;
 if(isX&&status)root=[...document.querySelectorAll("article")].find(a=>[...a.querySelectorAll("a time")].some(t=>t.closest("a")?.href.includes(`/status/${status}`)));
 else root=document.querySelector("#js_content,article,main,[role=main]")||document.body;
 if(!root)throw new Error("capture_unavailable");
 const safeURL=value=>{try{if(!value?.trim())return "";const u=new URL(value,location.href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:"";}catch{return "";}};
 const doc=document.cloneNode(false);doc.append(document.documentElement.cloneNode(false));
 const head=document.head.cloneNode(true),body=document.createElement("body"),clone=root.cloneNode(true);doc.documentElement.append(head,body);body.append(clone);clone.id="cairn-capture-root";
 // Preserve live URL resolution and computed visibility before cloning. No
 // content scoring or HTML-to-Markdown walker lives in Cairn anymore.
 const live=[root,...root.querySelectorAll("*")],copied=[clone,...clone.querySelectorAll("*")];
 const imageSources=new Map(),media=[];
 for(let i=0;i<live.length;i++){
  const el=live[i],copy=copied[i],style=getComputedStyle(el);
  if(style.display==="none"||style.visibility==="hidden"||el.matches("[hidden],[aria-hidden=true],input,textarea,select,form,button,script,style,noscript,[contenteditable=true]")){copy.remove();continue;}
  if(el.tagName==="IMG"){
   const lazy=el.getAttribute("data-original")||el.getAttribute("data-src")||el.getAttribute("data-lazy-src");
   const url=safeURL(lazy||el.currentSrc||el.src);
   if(!url||(!lazy&&el.complete&&el.naturalWidth>0&&(el.naturalWidth<40||el.naturalHeight<40))){copy.remove();continue;}
   copy.setAttribute("src",url);copy.removeAttribute("srcset");imageSources.set(url,el);
  }
  if(el.tagName==="A"){const url=safeURL(el.href);if(url)copy.setAttribute("href",url);else copy.removeAttribute("href");}
  if(["VIDEO","AUDIO"].includes(el.tagName)){
   const url=[el.currentSrc,el.src,...[...el.querySelectorAll("source")].map(s=>s.src)].map(safeURL).find(Boolean)||"";
   const kind=el.tagName.toLowerCase();media.push({kind,url,title:el.getAttribute("aria-label")||(kind==="video"?"视频":"音频")});
   copy.replaceWith(doc.createTextNode(`\n\n[${kind==="video"?"视频":"音频"}：归档状态见媒体区]\n\n`));
  }
 }
 // Defuddles X extractor knows tweetText and excludes author, translation,
 // statistics and controls. Article and generic pages use its DOM scoring.
 const references=isX?[...clone.querySelectorAll('[data-testid="tweetText"] a[href]')].map(a=>({url:safeURL(a.href),text:a.textContent.trim()})).filter(a=>a.url):[];
 let result;
 try{result=new Defuddle(doc,{url:location.href,contentSelector:"#cairn-capture-root",useAsync:false,includeReplies:false,removeSmallImages:false,removeHiddenElements:false}).parse();}catch{throw new Error("capture_unavailable");}
 if(!result.content?.trim())throw new Error("capture_unavailable");
 const parsed=new DOMParser().parseFromString(DOMPurify.sanitize(result.content,{FORBID_TAGS:["script","style","form","input","textarea","button","iframe"],FORBID_ATTR:["style"],ALLOW_DATA_ATTR:false}),"text/html");
 if(references.length){const section=parsed.createElement("section"),seen=new Set([...parsed.querySelectorAll('a[href]')].map(a=>a.href));
 for(const reference of references)if(!seen.has(reference.url)){const p=parsed.createElement('p'),a=parsed.createElement('a');a.href=reference.url;a.textContent=reference.text||reference.url;p.append(a);section.append(p);seen.add(reference.url);}
 if(section.childNodes.length){const h=parsed.createElement('h2');h.textContent='相关链接';section.prepend(h);parsed.body.append(section);}}
 const images=[];
 for(const img of parsed.querySelectorAll("img")){
  const url=safeURL(img.getAttribute("src"));if(!url){img.remove();continue;}
  const original=imageSources.get(url),index=images.length,alt=(img.alt||"图片").replace(/[\[\]\r\n]/g," ").slice(0,200);let data;
  if(!preview&&index<24&&original?.naturalWidth>0&&safeURL(original.currentSrc||original.src)===url)try{
   const canvas=document.createElement("canvas"),scale=Math.min(1,1800/Math.max(original.naturalWidth,original.naturalHeight));canvas.width=Math.round(original.naturalWidth*scale);canvas.height=Math.round(original.naturalHeight*scale);canvas.getContext("2d").drawImage(original,0,0,canvas.width,canvas.height);data=canvas.toDataURL("image/webp",.88);
  }catch{}
  images.push({url,data,alt});img.setAttribute("src",`cairn-image:${index}`);img.setAttribute("alt",alt);
 }
 const converter=new TurndownService({headingStyle:"atx",codeBlockStyle:"fenced",bulletListMarker:"-"});converter.use(gfm);
 // Image links should not erase the archive marker or force a source click.
 converter.addRule("archived-image-link",{filter:node=>node.nodeName==="A"&&node.children.length===1&&node.firstElementChild?.tagName==="IMG",replacement:content=>content});
 let text=converter.turndown(parsed.body).trim();
 if(!text)throw new Error("capture_unavailable");
 if(media.length&&!text.includes("归档状态见媒体区"))text+="\n\n[媒体：归档状态见媒体区]";
 const encoder=new TextEncoder();let truncated=false;
 while(encoder.encode(text).length>90000){text=text.slice(0,-1000);truncated=true;}
 return {text,title:(result.title||document.title).slice(0,300),language:(document.documentElement.lang||"und").slice(0,32),images,media,truncated};
}
globalThis.__cairnExtractPage=extractPageWithLibraries;
