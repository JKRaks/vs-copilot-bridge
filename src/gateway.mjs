import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import { toOpenAI, fromOpenAI, toOllamaStream } from './ollama.mjs';
import { createLogger } from './logger.mjs';
import { validateModels } from './config-store.mjs';
import { watchModels } from './model-store.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.argv[2] || resolve(folder, '../config/config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const modes = (process.env.GATEWAY_MODES || 'openai,ollama').split(',').map(value => value.trim());
if (!modes.length || modes.some(mode => !['openai', 'ollama'].includes(mode))) throw new Error('Choose openai and/or ollama');
const providers = config.providers || {};
let models = config.models || {};
for (const [name, provider] of Object.entries(providers)) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid baseUrl: ${name}`);
  provider.key = process.env[provider.apiKeyEnv] || provider.apiKey || '';
}
validateModels(models, providers);
const logPath = resolve(folder, '../logs/gateway.jsonl');
const log = createLogger(logPath, { secrets: [config.gatewayKey, ...Object.values(providers).map(p => p.key)] });
const stopWatching = watchModels(configPath, models, providers, next => {
  models = next;
  log('server', 'models.reloaded', { count: enabledModels().length });
}, error => log('server', 'models.reload.error', { message: error.message }));
function enabledModels() { return Object.keys(models).filter(alias => models[alias].enabled !== false); }
function getModel(alias) { return Object.hasOwn(models, alias) && models[alias].enabled !== false ? models[alias] : null; }
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function modelInfo(alias) { return { id: alias, object: 'model', created: 0, owned_by: models[alias].provider, description: models[alias].description || '' }; }
function ollamaModel(alias) {
  return { name: alias, model: alias, description: models[alias].description || '', modified_at: '2026-01-01T00:00:00Z', size: 0, digest: '',
    details: { format: 'api', family: models[alias].model, families: [models[alias].model], parameter_size: '', quantization_level: '' } };
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw fail('Request exceeds 16 MiB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON request'); }
}
async function write(res, data) {
  if (res.destroyed) throw new Error('Client disconnected');
  if (!res.write(data)) await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Client disconnected')); };
    const failed = error => { cleanup(); reject(error); };
    res.once('drain', drained); res.once('close', closed); res.once('error', failed);
  });
}
async function* textChunks(response, id) {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of response) {
    const text = decoder.write(chunk);
    if (config.debug) log(id, 'upstream.chunk', { text });
    yield text;
  }
  const tail = decoder.end();
  if (tail) yield tail;
}

async function forward(req, res, body, ollama, path, id) {
  const alias = body.model;
  const route = getModel(alias);
  if (!route) throw fail(`Unknown model: ${alias}`, 404);
  const provider = providers[route.provider];
  if (!provider.key) throw fail(`Configure API key for provider: ${route.provider}`, 503);
  const payload = ollama ? toOpenAI(body, route.model) : { ...body, model: route.model };
  const target = provider.baseUrl.replace(/\/+$/, '') + (ollama ? '/chat/completions' : path.replace(/^\/v1/, ''));
  const bytes = Buffer.from(JSON.stringify(payload));
  log(id, 'upstream.request', { alias, provider: route.provider, model: route.model, target, ...(config.debug ? { body: payload } : {}) });
  const transport = target.startsWith('https:') ? https : http;
  const upstream = transport.request(target, { method: 'POST', headers: {
    authorization: `Bearer ${provider.key}`, 'content-type': 'application/json',
    'content-length': bytes.length, 'accept-encoding': 'identity', accept: payload.stream ? 'text/event-stream' : 'application/json',
  } });
  const started = Date.now();
  let response;
  const cancel = () => { if (!res.writableFinished) { response?.destroy(); upstream.destroy(new Error('Client disconnected')); } };
  res.once('close', cancel);
  // Keep an error listener installed throughout the request lifetime.
  upstream.on('error', error => log(id, 'upstream.error', { message: error.message }));
  upstream.setTimeout(config.timeoutMs || 180000, () => upstream.destroy(new Error('Upstream idle timeout')));
  try {
    const ready = once(upstream, 'response');
    upstream.end(bytes);
    [response] = await ready;
    log(id, 'upstream.response', { status: response.statusCode, elapsedMs: Date.now() - started });
    if (!ollama) {
      res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json',
        ...(response.headers['content-encoding'] ? { 'content-encoding': response.headers['content-encoding'] } : {}),
        ...(response.headers['retry-after'] ? { 'retry-after': response.headers['retry-after'] } : {}) });
      res.flushHeaders();
      for await (const chunk of response) {
        if (config.debug) log(id, 'upstream.chunk', { text: chunk.toString('utf8') });
        await write(res, chunk);
      }
    } else if (response.statusCode >= 400 || payload.stream === false) {
      let text = ''; for await (const chunk of textChunks(response, id)) text += chunk;
      if (response.statusCode >= 400) { json(res, response.statusCode, { error: text }); return; }
      json(res, 200, fromOpenAI(JSON.parse(text), alias)); return;
    } else {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.flushHeaders();
      for await (const packet of toOllamaStream(textChunks(response, id), alias)) {
        if (config.debug) log(id, 'ollama.chunk', { packet });
        await write(res, JSON.stringify(packet) + '\n');
      }
    }
    res.end();
  } catch (error) {
    if (ollama && res.headersSent && !res.destroyed) res.end(JSON.stringify({ error: error.message }) + '\n');
    else throw error;
  } finally {
    response?.destroy(); upstream.destroy();
    res.removeListener('close', cancel);
    log(id, 'request.end', { elapsedMs: Date.now() - started });
  }
}

async function handle(req, res, id) {
  const path = new URL(req.url, 'http://localhost').pathname;
  log(id, 'request', { method: req.method, path });
  const ollama = path.startsWith('/api/');
  if ((ollama && !modes.includes('ollama')) || (path.startsWith('/v1/') && !modes.includes('openai'))) throw fail('This proxy mode is disabled', 404);
  // Ollama clients often have no API-key field: restricted to loopback listener.
  if (path.startsWith('/v1/') && config.gatewayKey && req.headers.authorization !== `Bearer ${config.gatewayKey}`) throw fail('Invalid gateway API key', 401);
  if (req.method === 'GET') {
    if (path === '/health') return json(res, 200, { ok: true, modes });
    if (path === '/') { res.end('Local model gateway is running'); return; }
    if (path === '/v1/models') return json(res, 200, { object: 'list', data: enabledModels().map(modelInfo) });
    if (path.startsWith('/v1/models/')) {
      const alias = decodeURIComponent(path.slice('/v1/models/'.length));
      if (!getModel(alias)) throw fail('Unknown or disabled model', 404);
      return json(res, 200, modelInfo(alias));
    }
    if (path === '/api/tags') return json(res, 200, { models: enabledModels().map(ollamaModel) });
    if (path === '/api/version') return json(res, 200, { version: '0.6.0' });
  }
  if (req.method !== 'POST') throw fail('Route not found', 404);
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Expected JSON object');
  if (path === '/api/show') {
    const alias = body.model || body.name;
    const route = getModel(alias);
    if (!route) throw fail('Unknown model', 404);
    return json(res, 200, { details: ollamaModel(alias).details, description: route.description || '', parameters: '', template: '',
      model_info: { 'general.architecture': 'gateway', ...(route.contextLength ? { 'gateway.context_length': route.contextLength } : {}) },
      capabilities: ['completion', ...(route.tools ? ['tools'] : []), ...(route.vision ? ['vision'] : [])] });
  }
  if (!['/v1/chat/completions', '/v1/responses', '/api/chat'].includes(path)) throw fail('Route not supported', 404);
  return forward(req, res, body, ollama, path, id);
}
const server = http.createServer((req, res) => {
  const id = randomUUID().slice(0, 8);
  handle(req, res, id).catch(error => {
    log(id, 'error', { message: error.message });
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else json(res, error.status || 502, new URL(req.url, 'http://localhost').pathname.startsWith('/api/')
      ? { error: error.message } : { error: { message: error.message, type: 'gateway_error' } });
  });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.on('close', stopWatching);
server.listen(config.port || 8788, '127.0.0.1', () => log('server', 'listening', {
  modes, ...(modes.includes('openai') ? { openai: `http://127.0.0.1:${config.port || 8788}/v1` } : {}),
  ...(modes.includes('ollama') ? { ollama: `http://127.0.0.1:${config.port || 8788}` } : {}),
  models: enabledModels(), missingKeys: Object.entries(providers).filter(([, p]) => !p.key).map(([n]) => n), logPath,
}));
