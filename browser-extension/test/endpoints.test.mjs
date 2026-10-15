import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServer, connectionIdentity, DEFAULT_SERVER, tokenIdentity, CaptureError } from '../src/config.mjs';
import { createController } from '../src/controller.mjs';

test('service origins require HTTPS except exact loopback and reject embedded credentials or paths', () => {
  for (const url of ['https://example.test/', 'http://localhost:9000', 'http://127.0.0.1:8090', 'http://[::1]:8090'])
    assert.equal(normalizeServer(url), new URL(url).origin);
  for (const url of ['http://example.test', 'http://localhost.evil.test', 'https://user:secret@example.test', 'https://example.test/api', 'https://example.test?x=1', 'https://example.test/#x', 'file:///tmp/x', '', 'https://'])
    assert.throws(() => normalizeServer(url), {kind:'invalid_server'});
});
test('existing queues keep their identity; a different server using the same token gets a new identity', async () => {
  const token='cairn_c_test';
  assert.equal(await connectionIdentity({token}), await tokenIdentity(token));
  assert.equal(await connectionIdentity({token,server:DEFAULT_SERVER}), await tokenIdentity(token));
  assert.notEqual(await connectionIdentity({token,server:'https://second.example'}), await tokenIdentity(token));
});
test('a server switch is atomic, checks the queue, clears old caches and binds requests to the saved origin', async () => {
  let saved;
  const calls=[];
  const controller=createController({
    store:{read:async()=>structuredClone(saved),write:async value=>{saved=structuredClone(value);}},
    clientFor:settings=>({
      test:async()=>{if(settings.server==='https://failed.example')throw new CaptureError('network');},
      upload:async(token,job)=>{calls.push({server:settings.server,token});return {id:1,url:job.url,note:job.note};}
    })
  });
  const connect=server=>controller.saveSettings({server,token:'cairn_c_test',keepFullUrl:true});
  await connect('https://first.example');
  const before=await controller.snapshot();
  const job={client_id:crypto.randomUUID(),url:'https://article.example/',note:''};
  await controller.enqueue(job);
  await assert.rejects(connect('https://failed.example'),{kind:'network'});
  assert.equal((await controller.snapshot()).binding,before.binding);
  await assert.rejects(connect('https://second.example'),{kind:'queue_connection'});
  assert.equal(saved.settings.server,'https://first.example');
  saved.collectionCatalog={binding:before.binding,items:[{id:'old'}]};
  await controller.saveSettings({server:'https://second.example',token:'',keepFullUrl:true,movePending:true});
  assert.equal(saved.collectionCatalog,undefined);
  assert.notEqual((await controller.snapshot()).binding,before.binding);
  await controller.flush();
  assert.deepEqual(calls,[{server:'https://second.example',token:'cairn_c_test'}]);
  assert.equal(saved.queue.length,0);
});
