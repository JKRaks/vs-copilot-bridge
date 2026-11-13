import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const enableMouse = "\x1b[?1000h\x1b[?1006h";
export const disableMouse = "\x1b[?1000l\x1b[?1006l";

// 在 readline 之前拆出 SGR 鼠标报告，避免坐标字符进入输入框或触发快捷键。
export class TerminalInput extends Transform {
  constructor(onMouse, escapeDelay = 50) {
    super();
    this.onMouse = onMouse;
    this.escapeDelay = escapeDelay;
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
  }

  _transform(chunk, encoding, done) {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.write(chunk);
    this.drainInput();
    done();
  }

  drainInput() {
    while (this.pending) {
      const start = this.pending.indexOf("\x1b");
      if (start < 0) {
        this.push(this.pending);
        this.pending = "";
        break;
      }
      if (start > 0) {
        this.push(this.pending.slice(0, start));
        this.pending = this.pending.slice(start);
      }
      if (this.pending === "\x1b" || this.pending === "\x1b[") {
        this.waitForEscape();
        break;
      }
      if (!this.pending.startsWith("\x1b[<")) {
        this.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
      if (!match) {
        if (/^\x1b\[<[\d;]*$/.test(this.pending) && this.pending.length < 64) {
          this.waitForEscape();
          break;
        }
        // 丢弃不完整或异常的鼠标控制序列，不让它变成用户输入。
        this.pending = this.pending.replace(/^\x1b\[<[^A-Za-z]*[A-Za-z]?/, "");
        continue;
      }
      this.pending = this.pending.slice(match[0].length);
      const button = Number(match[1]);
      const x = Number(match[2]) - 1;
      const y = Number(match[3]) - 1;
      if (match[4] === "m" || x < 0 || y < 0 || (button & 60))
        continue;
      if (button === 0)
        this.onMouse({ type: "click", x, y });
      else if (button === 64 || button === 65)
        this.onMouse({ type: "wheel", x, y, direction: button === 64 ? -1 : 1 });
    }
  }

  waitForEscape() {
    this.escapeTimer = setTimeout(() => {
      if (!this.pending.startsWith("\x1b[<"))
        this.push(this.pending);
      this.pending = "";
    }, this.escapeDelay);
  }

  _flush(done) {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.end();
    if (!this.pending.startsWith("\x1b[<"))
      this.push(this.pending);
    this.pending = "";
    done();
  }

  _destroy(error, done) {
    clearTimeout(this.escapeTimer);
    done(error);
  }
}

// 热区使用终端单元格坐标；顶部弹层和操作按钮优先于内容区域。
export function hitTest(regions, x, y) {
  return regions.findLast((region) =>
    x >= region.x && x < region.x + region.width &&
    y >= region.y && y < region.y + region.height);
}
