// Executed only after a user saves the active page. No background page tracking.
export function extractPage(expectedURL) {
  if (location.href !== expectedURL) throw new Error('page_changed');
  const isX = /(^|\.)(x|twitter)\.com$/.test(location.hostname);
  const status = location.pathname.match(/\/status\/(\d+)/)?.[1];
  let root;
  if (isX && status) root = [...document.querySelectorAll('article')].find(a =>
    [...a.querySelectorAll('a time')].some(t => t.closest('a')?.href.includes(`/status/${status}`)));
  else root = document.querySelector('#js_content, article, main, [role="main"]') || document.body;
  if (!root) throw new Error('capture_unavailable');
  const images = [];
  const excluded = 'script,style,noscript,nav,header,footer,aside,button,input,textarea,select,form,[contenteditable="true"],[aria-hidden="true"],[hidden]';
  const safeURL = value => { try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  function walk(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1 || node.matches(excluded)) return '';
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') {
      const url = safeURL(node.currentSrc || node.src);
      if (!url || node.naturalWidth < 100 || node.naturalHeight < 60) return '';
      const index = images.length;
      const alt = (node.alt || '图片').replace(/[\[\]\r\n]/g, ' ').slice(0,200);
      let data;
      if (index < 24) { try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1800 / Math.max(node.naturalWidth, node.naturalHeight));
        canvas.width = Math.round(node.naturalWidth * scale); canvas.height = Math.round(node.naturalHeight * scale);
        canvas.getContext('2d').drawImage(node,0,0,canvas.width,canvas.height);
        data = canvas.toDataURL('image/webp', .88);
      } catch { /* Cross-origin images may need the optional image permission. */ } }
      images.push({url, data, alt});
      return `\n\n![${alt}](cairn-image:${index})\n\n`;
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
  return { text, title: document.title.slice(0,300), language: (document.documentElement.lang || 'und').slice(0,32), images, truncated };
}

export async function captureTab(ext, tabId, expectedURL) {
  const [{result}] = await ext.scripting.executeScript({target:{tabId}, func:extractPage, args:[expectedURL]});
  if (!result?.text) throw new Error('capture_unavailable');
  const deadline = Date.now() + 12000;
  let bytes = 0;
  const images = [];
  let missing = 0;
  for (let i=0;i<result.images.length;i++) {
    const source = result.images[i];
    let data = source.data;
    try {
      if (Date.now() > deadline) throw new Error();
      if (!data && images.length < 24) {
        const response = await fetch(source.url, {credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(4000)});
        if (!response.ok || Number(response.headers.get('content-length')) > 1048576) throw new Error();
        const reader = response.body.getReader(); const chunks=[]; let size=0;
        for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.length; if(size>1048576){await reader.cancel();throw new Error();} chunks.push(value); }
        const blob = new Blob(chunks,{type:response.headers.get('content-type')?.split(';')[0]});
        const raw = new Uint8Array(await blob.arrayBuffer());
        let binary=''; for(const b of raw) binary+=String.fromCharCode(b);
        data = `data:${blob.type};base64,${btoa(binary)}`;
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
  return {...result, text:result.text.replace(/cairn-asset:/g,'cairn-image:'), images, missing_images:missing};
}
