const fs = require('fs');
const path = require('path');

class Logger {
  constructor(config = {}) {
    this.dir = config.dir || path.join(process.cwd(), 'logs');
    this.maxFiles = config.maxFiles || 7;
    this.stream = null;
    this._ensureDir();
    this._openFile();
    this._cleanup();
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  _openFile() {
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.dir, `kolonka-${date}.log`);
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  _cleanup() {
    try {
      const files = fs.readdirSync(this.dir)
        .filter(f => f.startsWith('kolonka-') && f.endsWith('.log'))
        .sort();
      while (files.length > this.maxFiles) {
        const old = files.shift();
        try { fs.unlinkSync(path.join(this.dir, old)); } catch {}
      }
    } catch {}
  }

  _ts() {
    return new Date().toISOString().slice(11, 23);
  }

  info(msg) {
    const line = `${this._ts()} [INFO] ${msg}`;
    if (this.stream) this.stream.write(line + '\n');
    return line;
  }

  warn(msg) {
    const line = `${this._ts()} [WARN] ${msg}`;
    if (this.stream) this.stream.write(line + '\n');
    return line;
  }

  error(msg) {
    const line = `${this._ts()} [ERR]  ${msg}`;
    if (this.stream) this.stream.write(line + '\n');
    return line;
  }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

module.exports = Logger;
