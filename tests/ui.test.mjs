import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { loadConfig, saveConfig, updateEntry, deleteEntry } from '../src/config-store.mjs';
import { GatewayRuntime } from '../src/runtime.mjs';

const sample = () => ({port:8788,timeoutMs:180000,gatewayKey:'local',debug:false,
  providers:{one:{baseUrl:'https://example.com/v1',apiKey:'secret',apiKeyEnv:''}},models:{alias:{provider:'one',model:'real',tools:true}}});
test('config validates before save and keeps provider references consistent',()=>{
  const dir=mkdtempSync(join(tmpdir(),'gateway-ui-test-'));const path=join(dir,'config.json');
  try {
    saveConfig(path,sample()); const before=readFileSync(path,'utf8');
    assert.throws(()=>saveConfig(path,{...sample(),port:99999}));assert.equal(readFileSync(path,'utf8'),before);
    const renamed=updateEntry(sample(),'providers','one','two',sample().providers.one);
    assert.equal(renamed.models.alias.provider,'two');
    assert.throws(()=>deleteEntry(renamed,'providers','two'),/引用/);
    saveConfig(path,renamed);assert.equal(loadConfig(path).providers.two.apiKey,'secret');
    assert.throws(()=>updateEntry(sample(),'models',null,'bad',{provider:'missing',model:'x'}));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('runtime starts selected protocol, captures events and releases port on stop',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gateway-runtime-test-'));const path=join(dir,'config.json');
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  saveConfig(path,{...sample(),port});
  const runtime=new GatewayRuntime(fileURLToPath(new URL('../src/gateway.mjs',import.meta.url)),path);
  try {
    const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout')),5000);runtime.on('change',()=>{if(runtime.state==='running'){clearTimeout(timer);resolve();}});});
    runtime.start(['ollama']);await ready;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/tags`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status,404);
    await runtime.stop();assert.equal(runtime.state,'stopped');assert.equal(runtime.child,null);
    await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));
  } finally {await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
