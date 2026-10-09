import { readFileSync, writeFileSync, renameSync } from 'node:fs';
export function validateModels(models, providers) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('模型映射必须为对象');
  for (const [id, m] of Object.entries(models)) {
    if (!id.trim() || ['__proto__','constructor','prototype'].includes(id)) throw new Error('模型名称无效');
    if (!m || !Object.hasOwn(providers,m.provider)) throw new Error(`${id}: 提供商不存在`);
    if (typeof m.model !== 'string' || !m.model.trim()) throw new Error('上游模型不能为空');
    if (m.contextLength !== undefined && (!Number.isInteger(m.contextLength) || m.contextLength < 1)) throw new Error('上下文长度必须为正整数');
    for (const flag of ['enabled','tools','vision']) if (m[flag] !== undefined && typeof m[flag] !== 'boolean') throw new Error(`${id}: ${flag} 必须为布尔值`);
    if (m.description !== undefined && typeof m.description !== 'string') throw new Error(`${id}: 描述必须为文本`);
  }
}
export function validateConfig(c) {
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('端口必须为 1–65535 的整数');
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000) throw new Error('超时必须为至少 1000 毫秒的整数');
  if (typeof c.gatewayKey !== 'string' || typeof c.debug !== 'boolean') throw new Error('Key 或 debug 格式错误');
  for (const [id, p] of Object.entries(c.providers || {})) {
    if (!id.trim() || ['__proto__','constructor','prototype'].includes(id)) throw new Error('提供商 ID 无效');
    const u = new URL(p.baseUrl);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(`${id}: API 地址无效`);
    if (typeof p.apiKey !== 'string' || typeof p.apiKeyEnv !== 'string') throw new Error('Key 配置格式错误');
  }
  validateModels(c.models || {}, c.providers);
}
export function loadConfig(path) { const c=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));validateConfig(c);return c; }
export function saveConfig(path,c) { validateConfig(c);writeFileSync(path+'.tmp',JSON.stringify(c,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path); }
export function updateEntry(c,section,original,id,value) {
  const next=structuredClone(c);
  if(id!==original && Object.hasOwn(next[section],id)) throw new Error('名称已存在');
  if(original) delete next[section][original];
  Object.defineProperty(next[section],id,{value,enumerable:true,writable:true,configurable:true});
  if(section==='providers' && original && original!==id) for(const m of Object.values(next.models)) if(m.provider===original)m.provider=id;
  validateConfig(next);return next;
}
export function deleteEntry(c,section,id) {
  if(section==='providers' && Object.values(c.models).some(m=>m.provider===id))throw new Error('该提供商仍被模型引用');
  const next=structuredClone(c);delete next[section][id];return next;
}
