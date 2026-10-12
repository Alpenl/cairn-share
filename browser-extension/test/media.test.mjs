import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {archiveHLS,fetchMedia,mediaDigest} from '../src/media.mjs';
import {discoverMedia} from '../src/capture.mjs';

test('archives HLS manifests, video and separate audio bytes with local references',async()=>{
 const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="audio"\nvideo/list.m3u8\n';
 const payloads=new Map([
 ['https://cdn.test/audio/list.m3u8','#EXTM3U\n#EXTINF:1,\naudio.aac\n#EXT-X-ENDLIST'],
 ['https://cdn.test/video/list.m3u8','#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\npart.m4s\n#EXT-X-ENDLIST'],
 ['https://cdn.test/audio/audio.aac','AUDIO_BYTES'],['https://cdn.test/video/init.mp4','INIT_BYTES'],['https://cdn.test/video/part.m4s','VIDEO_BYTES']]);
 const blob=await archiveHLS('https://cdn.test/master.m3u8',new Blob([master]),async url=>{assert.ok(payloads.has(url));return new Blob([payloads.get(url)]);});
 const zip=await JSZip.loadAsync(await blob.arrayBuffer(),{checkCRC32:true});
 const files=await Promise.all(Object.values(zip.files).map(f=>f.async('string')));
 assert.ok(files.includes('AUDIO_BYTES'));assert.ok(files.includes('VIDEO_BYTES'));assert.ok(files.includes('INIT_BYTES'));
 assert.match(await zip.file('index.m3u8').async('string'),/URI="audio.m3u8"/);
 assert.match(await zip.file('video.m3u8').async('string'),/URI="segment-\d+.bin"/);
 assert.ok(!files.some(t=>t.includes('https://')));
});
test('does not claim a live or encrypted stream is completely archived',async()=>{
 await assert.rejects(archiveHLS('https://cdn.test/list.m3u8',new Blob(['#EXTM3U\n#EXTINF:1,\na.ts'])),e=>e.kind==='media_live_or_unsupported');
 await assert.rejects(archiveHLS('https://cdn.test/list.m3u8',new Blob(['#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXT-X-ENDLIST'])),e=>e.kind==='media_protected');
});
test('binds X videos to the selected post and selects the original highest bitrate file',async()=>{
 const data={id_str:'123',mediaDetails:[{type:'video',video_info:{variants:[{content_type:'video/mp4',bitrate:200,url:'https://video.twimg.com/high.mp4'},{content_type:'video/mp4',bitrate:100,url:'https://video.twimg.com/low.mp4'}]}}]};
 const found=await discoverMedia('https://x.com/user/status/123',[{kind:'video',url:'',title:'video'}],async()=>Response.json(data));
 assert.equal(found[0].url,'https://video.twimg.com/high.mp4');
 const mismatch=await discoverMedia('https://x.com/user/status/456',[],async()=>Response.json(data));assert.deepEqual(mismatch,[]);
});


test('downloads and hashes files beyond 256 MiB without reading the whole Blob into JavaScript',async()=>{
 const chunk=new Uint8Array(1024*1024).fill(42);
 const expected=createHash('sha256');for(let i=0;i<257;i++)expected.update(chunk);
 for(const knownSize of [true,false]){
  let remaining=257;
  const blob=await fetchMedia('https://cdn.test/large.mp4',{fetchImpl:async()=>new Response(new ReadableStream({pull(c){if(remaining-- > 0)c.enqueue(chunk);else c.close();}}),{headers:{'Content-Type':'video/mp4',...(knownSize?{'Content-Length':String(257*chunk.length)}:{})}})});
  assert.equal(blob.size,257*chunk.length);
  blob.arrayBuffer=()=>{throw new Error('Whole-file buffering is forbidden');};
  assert.equal(await mediaDigest(blob),expected.copy().digest('hex'));
 }
});

test('downloads may exceed the timeout while bytes keep arriving',async()=>{
 let remaining=8;
 const blob=await fetchMedia('https://cdn.test/slow.mp4',{idleTimeoutMs:200,fetchImpl:async(_url,{signal})=>new Response(new ReadableStream({
  start(c){signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});},
  async pull(c){await new Promise(r=>setTimeout(r,50));if(remaining-- > 0)c.enqueue(new Uint8Array([42]));else c.close();}
 }))});
 assert.equal(blob.size,8);
});

test('stalled downloads still time out',async()=>{
 await assert.rejects(fetchMedia('https://cdn.test/stalled.mp4',{idleTimeoutMs:50,fetchImpl:async(_url,{signal})=>new Response(new ReadableStream({start(c){signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}}))}),e=>e.kind==='timeout');
});

test('archives more than 1000 HLS segments and manifests exceeding 1 MiB',async()=>{
 const manifest='#EXTM3U\n#'+'.'.repeat(1024*1024)+'\n'+Array.from({length:1001},(_,i)=>`#EXTINF:1,\n${i}.ts`).join('\n')+'\n#EXT-X-ENDLIST';
 const blob=await archiveHLS('https://cdn.test/list.m3u8',new Blob([manifest]),async url=>new Blob([new URL(url).pathname]));
 const zip=await JSZip.loadAsync(await blob.arrayBuffer(),{checkCRC32:true});
 assert.equal(Object.keys(zip.files).length,1002);
 assert.equal(await zip.file('segment-1000.bin').async('string'),'/1000.ts');
 assert.match(await zip.file('index.m3u8').async('string'),/segment-1000.bin/);
});

test('discovers every distinct media item beyond the former 16 item ceiling',async()=>{
 const media=Array.from({length:60},(_,i)=>({kind:'audio',url:`https://cdn.test/${i}.mp3`,title:`Track ${i}`}));
 const result=await discoverMedia('https://example.com/album',[...media,media[0]]);
 assert.deepEqual(result,media);
});
