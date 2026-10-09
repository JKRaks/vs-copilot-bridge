import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function createLogger(path, { secrets = [], maxBytes = 1024 * 1024, backups = 3, consoleOutput = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let size = existsSync(path) ? statSync(path).size : 0;
  function rotate() {
    const oldest = `${path}.${backups}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = backups - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    if (existsSync(path)) renameSync(path, `${path}.1`);
    size = 0;
  }
  function append(line) {
    const bytes = Buffer.byteLength(line + '\n');
    if (size + bytes > maxBytes) rotate();
    appendFileSync(path, line + '\n');
    size += bytes;
    if (consoleOutput) {
      if (process.env.GATEWAY_UI === '1') {
        const record = JSON.parse(line);
        if (record.event !== 'log.fragment' && !record.event?.endsWith('.chunk')) {
          const { body, text, packet, ...summary } = record;
          console.log(JSON.stringify(summary));
        }
      } else console.log(line);
    }
  }
  return (id, event, data = {}) => {
    let line = JSON.stringify({ time: new Date().toISOString(), id, event, ...data });
    for (const key of secrets.filter(Boolean)) line = line.split(key).join('[REDACTED]');
    line = line.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
    if (Buffer.byteLength(line + '\n') <= maxBytes) return append(line);
    // Preserve oversize records as numbered JSON string fragments, never exceed the file cap.
    // A code point costs <= 12 bytes after JSON escaping; reserve space for metadata.
    const count = Math.max(1, Math.floor((maxBytes - 512) / 12));
    const characters = Array.from(line);
    const parts = Math.ceil(characters.length / count);
    const recordId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    for (let part = 0; part < parts; part++) append(JSON.stringify({
      event: 'log.fragment', recordId, part: part + 1, parts,
      text: characters.slice(part * count, (part + 1) * count).join(''),
    }));
  };
}
