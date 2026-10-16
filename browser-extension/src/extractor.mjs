import Defuddle from "defuddle";
import TurndownService from "turndown";
import {gfm} from "turndown-plugin-gfm";
import DOMPurify from "dompurify";

export const MAX_COMMENTS=50;
function xHandle(article){
 const name=article?.querySelector('[data-testid="User-Name"]');if(!name)return "";
 for(const a of name.querySelectorAll("a")){const text=a.textContent.trim();if(/^@\w{1,15}$/.test(text))return text.toLowerCase();}
 for(const a of name.querySelectorAll("a[href]")){const m=new URL(a.getAttribute("href"),location.href).pathname.match(/^\/(\w{1,15})\/?$/);if(m)return `@${m[1].toLowerCase()}`;}
 return "";
}
// Authors often continue a post, or put the key link, in replies. Keep the
// selected post and the author's self-thread around it, plus (when comments
// are wanted) the replies X has already loaded, in page order, so Defuddle's
// X extractor can rebuild them.
function xConversation(focal,comments){
 const cell=focal.closest('[data-testid="cellInnerDiv"]'),container=cell?.parentElement;
 if(!container)return null;
 const cells=[...container.children].filter(c=>c.matches('[data-testid="cellInnerDiv"]')),index=cells.indexOf(cell),author=xHandle(focal);
 const keep=new Set([cell]),body=new Set([focal]);
 // Earlier posts are context only when they are the same author's thread.
 for(let i=index-1;author&&i>=0;i--){const article=cells[i].querySelector("article");if(!article)continue;if(xHandle(article)!==author)break;keep.add(cells[i]);body.add(article);}
 let thread=true,replies=0,truncated=false;
 for(const c of cells.slice(index+1)){
  const article=c.querySelector("article");
  // "Discover more" and similar trailing sections are not part of the post.
  if(!article){if(c.querySelector("h2,section"))break;keep.add(c);continue;}
  // Promoted posts carry no permalink timestamp.
  if(!article.querySelector('a[href*="/status/"] time'))continue;
  if(thread&&author&&xHandle(article)===author){keep.add(c);body.add(article);continue;}
  thread=false;
  if(!comments)break;
  if(replies>=MAX_COMMENTS){truncated=true;break;}
  replies++;keep.add(c);
 }
 return {container,cells:new Set(cells),keep,body,author,replies,truncated};
}

// WeChat renders 留言 below #js_content once the client allows it; other
// browsers usually show "加载失败" and an empty list, which yields nothing.
function wechatComments(){
 const text=el=>{if(!el)return "";const c=el.cloneNode(true);for(const br of c.querySelectorAll("br"))br.replaceWith("\n");for(const img of c.querySelectorAll("img[alt]"))img.replaceWith(img.alt);return c.textContent.split("\n").map(l=>l.trim()).filter(Boolean).join("\n");};
 const own=(item,selector,scope)=>[...item.querySelectorAll(selector)].find(el=>!scope||!el.closest(scope)||el.closest(scope)===item.closest(scope));
 const read=(item,scope)=>({
  name:text(own(item,".discuss_user_nickname",scope))||"读者",
  author:Boolean(own(item,".discuss_author_info",scope))||[...item.querySelectorAll(".discuss_relation_tips")].some(t=>(!scope||!t.closest(scope))&&t.textContent.trim()==="作者"),
  time:text(own(item,".discuss_send_time",scope)),
  content:text(own(item,".discuss_message_content",scope)),
 });
 const seen=new Set(),items=[];
 for(const li of document.querySelectorAll(".discuss_list .js_comment_item")){
  if(li.closest("#js_content")||li.matches(".cmt_ad_anchor_hidden,.discuss_item--nps")||getComputedStyle(li).display==="none"||seen.has(li.id))continue;
  if(li.id)seen.add(li.id);
  const comment=read(li,".js_reply_area");if(!comment.content)continue;
  comment.replies=[...li.querySelectorAll(".js_reply_list > *")].map(r=>read(r)).filter(r=>r.content);
  items.push(comment);
 }
 return items;
}
// Comment sections Defuddle has no extractor for. Reddit, Hacker News,
// GitHub, Discourse, Mastodon, Bluesky and Threads come from Defuddle itself.
const COMMENT_SECTIONS=[{host:/^mp\.weixin\.qq\.com$/,read:wechatComments,unit:"留言"}];
function appendComments(parsed,comments,unit,truncated){
 const section=parsed.createElement("section"),h=parsed.createElement("h2");
 h.textContent=`评论区（${comments.length} 条已加载的${unit}${truncated?"，其余未保存":""}）`;section.append(h);
 const render=(comment,parent)=>{
  const quote=parsed.createElement("blockquote"),meta=parsed.createElement("p"),name=parsed.createElement("strong");
  name.textContent=comment.name+(comment.author?"（作者）":"");meta.append(name);if(comment.time)meta.append(` · ${comment.time}`);quote.append(meta);
  for(const line of comment.content.split("\n")){const p=parsed.createElement("p");p.textContent=line;quote.append(p);}
  for(const reply of comment.replies||[])render(reply,quote);
  parent.append(quote);
 };
 for(const comment of comments)render(comment,section);
 parsed.body.append(section);
}

// Runs in the extensions isolated world; libraries are packaged locally.
// options.comments: also keep the page's loaded comment section.
export function extractPageWithLibraries(expectedURL, preview=false, options={}) {
 const wantComments=options?.comments!==false;
 if(location.href!==expectedURL)throw new Error("page_changed");
 const isX=/(^|\.)(x|twitter)\.com$/.test(location.hostname),status=location.pathname.match(/\/status\/(\d+)/)?.[1];
 let root,conversation=null;
 if(isX&&status){
  root=[...document.querySelectorAll("article")].find(a=>[...a.querySelectorAll("a time")].some(t=>t.closest("a")?.href.includes(`/status/${status}`)));
  conversation=root?xConversation(root,wantComments):null;
  if(conversation)root=conversation.container;
 }
 else root=document.querySelector("#js_content,article,main,[role=main]")||document.body;
 if(!root)throw new Error("capture_unavailable");
 const inBody=el=>!conversation||[...conversation.body].some(a=>a.contains(el));
 const safeURL=value=>{try{if(!value?.trim())return "";const u=new URL(value,location.href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:"";}catch{return "";}};
 const doc=document.cloneNode(false);doc.append(document.documentElement.cloneNode(false));
 const head=document.head.cloneNode(true),body=document.createElement("body"),clone=root.cloneNode(true);doc.documentElement.append(head,body);body.append(clone);clone.id="cairn-capture-root";
 // Preserve live URL resolution and computed visibility before cloning. No
 // content scoring or HTML-to-Markdown walker lives in Cairn anymore.
 const live=[root,...root.querySelectorAll("*")],copied=[clone,...clone.querySelectorAll("*")];
 const imageSources=new Map(),media=[],expandedLinks=[];let dropped=null;
 for(let i=0;i<live.length;i++){
  const el=live[i],copy=copied[i];
  // Posts outside the kept conversation contribute no images or media.
  if(dropped?.contains(el))continue;
  if(conversation?.cells.has(el)&&!conversation.keep.has(el)){copy.remove();dropped=el;continue;}
  const style=getComputedStyle(el);
  if(style.display==="none"||style.visibility==="hidden"||el.matches("[hidden],[aria-hidden=true],input,textarea,select,form,button,script,style,noscript,[contenteditable=true]")){copy.remove();continue;}
  if(conversation&&el.tagName==="ARTICLE"&&conversation.body.has(el))copy.setAttribute("data-cairn-body","");
  if(el.tagName==="IMG"){
   const lazy=el.getAttribute("data-original")||el.getAttribute("data-src")||el.getAttribute("data-lazy-src");
   const url=safeURL(lazy||el.currentSrc||el.src);
   if(!url||(!lazy&&el.complete&&el.naturalWidth>0&&(el.naturalWidth<40||el.naturalHeight<40))){copy.remove();continue;}
   copy.setAttribute("src",url);copy.removeAttribute("srcset");imageSources.set(url,el);
  }
  if(el.tagName==="A"){
   const url=safeURL(el.href);if(url)copy.setAttribute("href",url);else copy.removeAttribute("href");
   // X shortens links to t.co and hides part of the address; the live text
   // still holds the full destination, which Defuddle keeps as plain text.
   const shown=isX&&el.closest('[data-testid="tweetText"]')?el.textContent.trim().replace(/…$/,""):"";
   if(/^https?:\/\/\S+$/.test(shown)&&safeURL(shown))expandedLinks.push([copy,safeURL(shown)]);
  }
  if(["VIDEO","AUDIO"].includes(el.tagName)&&!inBody(el)){copy.replaceWith(doc.createTextNode(`[${el.tagName==="VIDEO"?"视频":"音频"}]`));dropped=el;continue;}
  if(["VIDEO","AUDIO"].includes(el.tagName)){
   const url=[el.currentSrc,el.src,...[...el.querySelectorAll("source")].map(s=>s.src)].map(safeURL).find(Boolean)||"";
   const kind=el.tagName.toLowerCase();media.push({kind,url,title:el.getAttribute("aria-label")||(kind==="video"?"视频":"音频")});
   copy.replaceWith(doc.createTextNode(`\n\n[${kind==="video"?"视频":"音频"}：归档状态见媒体区]\n\n`));
  }
 }
 for(const [copy,url] of expandedLinks){copy.textContent=url;copy.setAttribute("data-cairn-url",url);}
 // Defuddles X extractor knows tweetText and excludes author, translation,
 // statistics and controls; it lists the self-thread as post content and
 // other replies as comments. Article and generic pages use its DOM scoring.
 // Links from the post and its self-thread are also listed; reply links stay inline.
 const references=isX?[...clone.querySelectorAll(`${conversation?"[data-cairn-body] ":""}[data-testid="tweetText"] a[href]`)].map(a=>({url:a.getAttribute("data-cairn-url")||safeURL(a.href),text:a.textContent.trim()})).filter(a=>a.url):[];
 let result;
 try{result=new Defuddle(doc,{url:location.href,contentSelector:"#cairn-capture-root",useAsync:false,includeReplies:wantComments,removeSmallImages:false,removeHiddenElements:false}).parse();}catch{throw new Error("capture_unavailable");}
 if(!result.content?.trim())throw new Error("capture_unavailable");
 const parsed=new DOMParser().parseFromString(DOMPurify.sanitize(result.content,{FORBID_TAGS:["script","style","form","input","textarea","button","iframe"],FORBID_ATTR:["style"],ALLOW_DATA_ATTR:false}),"text/html");
 // Defuddle's comment-aware extractors (X and the sites listed above).
 let comments=parsed.querySelectorAll(".comments .comment").length;
 if(comments){
  for(const h of parsed.querySelectorAll(".comments > h2"))if(h.textContent.trim()==="Comments")h.textContent=`评论区（${comments} 条已加载的${isX?"回复":"评论"}${conversation?.truncated?"，其余未保存":""}）`;
  if(conversation?.author)for(const name of parsed.querySelectorAll(".comment-author strong"))if(name.textContent.trim().toLowerCase().endsWith(conversation.author))name.textContent+="（作者）";
 }
 const site=wantComments&&!comments&&COMMENT_SECTIONS.find(s=>s.host.test(location.hostname));
 if(site){let list=[];try{list=site.read();}catch{/* A changed comment widget must not block the article. */}
  if(list.length){appendComments(parsed,list.slice(0,MAX_COMMENTS),site.unit,list.length>MAX_COMMENTS);comments=Math.min(list.length,MAX_COMMENTS);}}
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
 return {text,title:(result.title||document.title).slice(0,300),language:(document.documentElement.lang||"und").slice(0,32),images,media,truncated,comments};
}
globalThis.__cairnExtractPage=extractPageWithLibraries;
