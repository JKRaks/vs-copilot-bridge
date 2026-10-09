import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../src/config-store.mjs';

test('hot reload disables both entrances, preserves in-flight requests and rejects invalid mappings', async () => {
  let release;
  let observed;
  const arrived = new Promise(resolve => { observed = resolve; });
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (body.model === 'old') { observed(); await new Promise(resolve => { release = resolve; }); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'gateway-reload-'));
  const path = join(directory, 'config.json');
  const config = { port, timeoutMs: 10000, debug: false, gatewayKey: '',
    providers: { mock: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'test', apiKeyEnv: '' } },
    models: { alias: { provider: 'mock', model: 'old', description: '旧备注' } } };
  saveConfig(path, config);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/gateway.mjs', import.meta.url)), path], { stdio: ['ignore','pipe','pipe'] });
  const base = `http://127.0.0.1:${port}`;
  const call = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function until(check) {
    for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Reload timeout');
  }
  let output = ''; child.stdout.on('data', data => { output += data; });
  try {
    await until(async () => output.includes('listening'));
    const pending = call('/v1/chat/completions', { model: 'alias', messages: [] });
    await arrived;
    config.models.alias.enabled = false; saveConfig(path, config);
    await until(async () => (await (await fetch(base + '/v1/models')).json()).data.length === 0);
    assert.equal((await (await fetch(base + '/api/tags')).json()).models.length, 0);
    for (const route of ['/v1/chat/completions','/v1/responses','/api/chat','/api/show']) assert.equal((await call(route, { model: 'alias' })).status, 404);
    assert.equal((await fetch(base + '/v1/models/alias')).status, 404);
    release(); assert.equal((await (await pending).json()).model, 'old');
    config.models.alias = { provider: 'mock', model: 'new', enabled: true, description: '新备注', vision: true };
    saveConfig(path, config);
    await until(async () => (await (await fetch(base + '/v1/models')).json()).data[0]?.description === '新备注');
    assert.equal((await (await call('/v1/chat/completions', { model: 'alias' })).json()).model, 'new');
    assert.ok((await (await call('/api/show', { model: 'alias' })).json()).capabilities.includes('vision'));
    writeFileSync(path, '{invalid');
    await until(async () => output.includes('models.reload.error'));
    assert.equal((await (await fetch(base + '/v1/models')).json()).data[0].id, 'alias');
    config.models.alias.provider = 'missing'; writeFileSync(path, JSON.stringify(config));
    await until(async () => output.includes('提供商不存在'));
    assert.equal((await (await fetch(base + '/api/tags')).json()).models[0].name, 'alias');
  } finally {
    release?.(); const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
