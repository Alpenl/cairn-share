import {keepImageFallback} from './images.mjs';
// Parsing libraries run only after the user invokes capture/preview.
export function extractPage(expectedURL, preview=false) {
 if(typeof globalThis.__cairnExtractPage!=="function")throw new Error("capture_unavailable");
 return globalThis.__cairnExtractPage(expectedURL,preview);
}
async function prepareExtractor(ext,tabId){
 await ext.scripting.executeScript({target:{tabId},files:["capture-extractor.js"]});
}

export async function captureTab(ext, tabId, expectedURL, clientID) {
  await prepareExtractor(ext,tabId);
  const [{result}]=await ext.scripting.executeScript({target:{tabId},func:extractPage,args:[expectedURL]});
  if(!result?.text)throw new Error('capture_unavailable');
  const images=[];let missing=0;
  for(let i=0;i<result.images.length;i++){
    const source=result.images[i];
    if(i<24){
      await keepImageFallback(clientID,i,source.data);
      images.push({url:source.url});
    }else{
      missing++;
      result.text=result.text.replace(`![${source.alt}](cairn-image:${i})`,`[图片未归档：${source.alt}](${source.url.replace(/\)/g,'%29')})`);
    }
  }
  return {...result,images,media:result.media||[],missing_images:missing,protocol:2};
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
