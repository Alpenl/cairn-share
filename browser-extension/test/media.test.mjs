import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {archiveHLS} from '../src/media.mjs';
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
