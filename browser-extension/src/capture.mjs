// Parsing libraries run only after the user invokes capture/preview.
export function extractPage(expectedURL, preview=false) {
 if(typeof globalThis.__cairnExtractPage!=="function")throw new Error("capture_unavailable");
 return globalThis.__cairnExtractPage(expectedURL,preview);
}
async function prepareExtractor(ext,tabId){
 await ext.scripting.executeScript({target:{tabId},files:["capture-extractor.js"]});
}

export async function captureTab(ext, tabId, expectedURL) {
  await prepareExtractor(ext,tabId);
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
  await prepareExtractor(ext,tabId);
  const [{result}] = await ext.scripting.executeScript({target:{tabId},func:extractPage,args:[url,true]});
  const origins = new Set();
  for (const item of [...(result?.images || []),...(result?.media || [])]) {
    try {const u=new URL(item.url);if(/^https?:$/.test(u.protocol))origins.add(`${u.protocol}//${u.hostname}/*`);}catch{}
  }
  if (/(^|\.)(x|twitter)\.com$/.test(new URL(url).hostname)) {origins.add('https://cdn.syndication.twimg.com/*');origins.add('https://video.twimg.com/*');}
  return [...origins];
}
