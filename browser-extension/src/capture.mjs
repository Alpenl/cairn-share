// Executed only after a user saves the active page. No background page tracking.
export function extractPage(expectedURL, preview = false) {
  if (location.href !== expectedURL) throw new Error('page_changed');
  const isX = /(^|\.)(x|twitter)\.com$/.test(location.hostname);
  const status = location.pathname.match(/\/status\/(\d+)/)?.[1];
  let root;
  if (isX && status) root = [...document.querySelectorAll('article')].find(a =>
    [...a.querySelectorAll('a time')].some(t => t.closest('a')?.href.includes(`/status/${status}`)));
  else root = document.querySelector('#js_content, article, main, [role="main"]') || document.body;
  if (!root) throw new Error('capture_unavailable');
  const images = [];
  const media = [];
  const excluded = 'script,style,noscript,nav,header,footer,aside,button,input,textarea,select,form,[contenteditable="true"],[aria-hidden="true"],[hidden]';
  const safeURL = value => { if(typeof value!=='string'||!value.trim())return ''; try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  function walk(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1 || node.matches(excluded)) return '';
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') {
      const lazy = node.getAttribute('data-original') || node.getAttribute('data-src') || node.getAttribute('data-lazy-src');
      const url = safeURL(lazy || node.currentSrc || node.src || node.getAttribute('srcset')?.split(',').at(-1)?.trim().split(/\s+/)[0]);
      if (!url || (!lazy && node.complete && node.naturalWidth > 0 && (node.naturalWidth < 40 || node.naturalHeight < 40))) return '';
      const index = images.length;
      const alt = (node.alt || '图片').replace(/[\[\]\r\n]/g, ' ').slice(0,200);
      let data;
      if (!preview && index < 24 && node.naturalWidth > 0 && (!lazy || safeURL(node.currentSrc || node.src)===url)) { try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1800 / Math.max(node.naturalWidth, node.naturalHeight));
        canvas.width = Math.round(node.naturalWidth * scale); canvas.height = Math.round(node.naturalHeight * scale);
        canvas.getContext('2d').drawImage(node,0,0,canvas.width,canvas.height);
        data = canvas.toDataURL('image/webp', .88);
      } catch { /* Cross-origin images may need the optional image permission. */ } }
      images.push({url, data, alt});
      return `\n\n![${alt}](cairn-image:${index})\n\n`;
    }
    if (tag === 'video' || tag === 'audio') {
      const urls = [node.currentSrc, node.src, ...[...node.querySelectorAll('source')].map(s => s.src)].map(safeURL).filter(Boolean);
      const url = urls[0] || '';
      media.push({kind:tag,url,title:node.getAttribute('aria-label') || (tag === 'video' ? '视频' : '音频')});
      return '\n\n['+(tag === 'video' ? '视频' : '音频')+'：归档状态见媒体区]\n\n';
    }
    if (tag === 'pre') return '\n\n```\n' + node.innerText.replace(/```/g,'` ` `') + '\n```\n\n';
    if (tag === 'br') return '\n';
    const text = [...node.childNodes].map(walk).join('');
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === 'li') return '\n' + (node.parentElement?.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node)+1}. ` : '- ') + text.trim() + '\n';
    if (tag === 'blockquote') return '\n\n' + text.trim().split('\n').map(t => '> '+t).join('\n') + '\n\n';
    if (tag === 'a') { const url = safeURL(node.href); return url && text.trim() ? `[${text.trim().replace(/[\[\]]/g,'')}](${url.replace(/\)/g,'%29')})` : text; }
    if (tag === 'code') return '`' + text.replace(/`/g,'') + '`';
    if (tag === 'strong' || tag === 'b') return '**' + text.trim() + '**';
    if (['p','div','section','article','ul','ol','table','tr'].includes(tag)) return '\n\n'+text.trim()+'\n\n';
    if (tag === 'td' || tag === 'th') return text.trim()+' | ';
    return text;
  }
  // On X, exclude the reply controls and other posts while retaining the selected post's media.
  let text = walk(root).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if (!text) throw new Error('capture_unavailable');
  const encoder = new TextEncoder();
  let truncated = false;
  while (encoder.encode(text).length > 90000) { text = text.slice(0, -1000); truncated = true; }
  return { text, title: document.title.slice(0,300), language: (document.documentElement.lang || 'und').slice(0,32), images, media, truncated };
}

export async function captureTab(ext, tabId, expectedURL) {
  const [{result}] = await ext.scripting.executeScript({target:{tabId}, func:extractPage, args:[expectedURL]});
  if (!result?.text) throw new Error('capture_unavailable');
  const deadline = Date.now() + 22000;
  let bytes = 0;
  const images = [];
  let missing = 0;
  for (let i=0;i<result.images.length;i++) {
    const source = result.images[i];
    let data;
    try {
      if (Date.now() > deadline) throw new Error();
      if (images.length < 24) {
        let response;
        try { response = await fetch(source.url, {credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(6000)}); }
        catch { if (!source.data) throw new Error('image_fetch_failed'); }
        if (!response?.ok || !/^image\/(png|jpeg|webp|gif|avif)(;|$)/i.test(response.headers.get('content-type') || '')) {
          if (!source.data) throw new Error('image_fetch_failed');
          data = source.data;
        } else {
        if (!response.ok || Number(response.headers.get('content-length')) > 1048576) throw new Error();
        const reader = response.body.getReader(); const chunks=[]; let size=0;
        for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.length; if(size>1048576){await reader.cancel();throw new Error();} chunks.push(value); }
        const blob = new Blob(chunks,{type:response.headers.get('content-type')?.split(';')[0]});
        const raw = new Uint8Array(await blob.arrayBuffer());
        let binary=''; for(const b of raw) binary+=String.fromCharCode(b);
        data = `data:${blob.type};base64,${btoa(binary)}`;
        }
      }
      const match = data?.match(/^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=]+)$/);
      if(!match || match[2].length>1400000 || bytes+match[2].length>5600000 || images.length>=24) throw new Error();
      bytes += match[2].length;
      result.text = result.text.replace(`(cairn-image:${i})`, `(cairn-asset:${images.length})`);
      images.push({content_type:match[1],data:match[2]});
    } catch {
      missing++;
      result.text = result.text.replace(`![${source.alt}](cairn-image:${i})`, `[图片未归档：${source.alt}](${source.url.replace(/\)/g,'%29')})`);
    }
  }
  while (new TextEncoder().encode(result.text).length > 99000) { result.text=result.text.slice(0,-1000);result.truncated=true; }
  const media = await discoverMedia(expectedURL, result.media || []);
  return {...result, text:result.text.replace(/cairn-asset:/g,'cairn-image:'), images, media, missing_images:missing};
}

// This public embed response binds media to the selected post ID. It avoids
// collecting videos from recommendations/replies or guessing blob: URLs.
export async function discoverMedia(pageURL, found, fetcher = fetch) {
  const u = new URL(pageURL), id = /(^|\.)(x|twitter)\.com$/.test(u.hostname) && u.pathname.match(/\/status\/(\d+)/)?.[1];
  if (id) {
    try {
      const response = await fetcher(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=0`, {credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error();
      const post = await response.json();
      if (post.id_str !== id) throw new Error();
      const videos = (post.mediaDetails || []).filter(m => ['video','animated_gif'].includes(m.type)).map((m,index) => {
        const variants = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4' && /^https:\/\/video\.twimg\.com\//.test(v.url)).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
        return {kind:'video',url:variants[0]?.url || '',title:`视频 ${index+1}`};
      });
      if (videos.length) return videos;
    } catch { /* The missing media remains visible and retryable. */ }
  }
  return found.filter((m,i,a)=>!m.url || a.findIndex(x=>x.url===m.url)===i).slice(0,16);
}

export async function mediaPermissions(ext, tabId, url) {
  const [{result}] = await ext.scripting.executeScript({target:{tabId},func:extractPage,args:[url,true]});
  const origins = new Set();
  for (const item of [...(result?.images || []),...(result?.media || [])]) {
    try {const u=new URL(item.url);if(/^https?:$/.test(u.protocol))origins.add(`${u.protocol}//${u.hostname}/*`);}catch{}
  }
  if (/(^|\.)(x|twitter)\.com$/.test(new URL(url).hostname)) {origins.add('https://cdn.syndication.twimg.com/*');origins.add('https://video.twimg.com/*');}
  return [...origins];
}
