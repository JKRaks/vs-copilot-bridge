export function formatLogLines(value, columns) {
  let content = value;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* Plain text keeps its line breaks. */ }
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const lines = [];
  for (const original of String(text ?? '').split(/\r\n|\n|\r/)) {
    const safe = original.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    let line = '', used = 0;
    for (const character of safe) {
      const size = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\u{1f000}-\u{1ffff}]/u.test(character) ? 2 : 1;
      if (used + size > columns && line) { lines.push(line); line = ''; used = 0; }
      line += character; used += size;
    }
    lines.push(line);
  }
  return lines;
}
