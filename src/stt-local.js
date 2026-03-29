const { spawn } = require('child_process');
const path = require('path');

// Find system Node.js path (not Electron's binary)
function getNodePath() {
  // In Electron, process.execPath is the Electron binary.
  // We need the system node to load native modules (vosk/ffi-napi).
  if (process.versions.electron) {
    // Use 'node' from PATH
    return 'node';
  }
  return process.execPath;
}

class LocalSTT {
  constructor(config = {}) {
    this.sampleRate = config.sampleRate || 16000;
    this.modelPath = config.modelPath || undefined;
    this.worker = null;
    this.ready = false;
    this.pending = new Map();
    this.nextId = 1;
    this._readyPromise = null;
  }

  init() {
    if (this.worker) return this._readyPromise;

    this._readyPromise = new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, 'stt-worker.js');
      const env = { ...process.env };
      if (this.modelPath) env.VOSK_MODEL_PATH = this.modelPath;

      const nodePath = getNodePath();

      this.worker = spawn(nodePath, [workerPath], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env,
        cwd: path.join(__dirname, '..'),
        windowsHide: true,
      });

      // Capture stderr for diagnostics
      let stderrBuf = '';
      this.worker.stderr.on('data', (d) => { stderrBuf += d.toString(); });

      this.worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          this.ready = true;
          resolve();
          return;
        }

        if (msg.type === 'result' || msg.type === 'error') {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            if (msg.type === 'result') cb.resolve(msg.text);
            else cb.reject(new Error(msg.message));
          }
        }
      });

      this.worker.on('error', (err) => {
        if (!this.ready) reject(err);
      });

      this.worker.on('exit', (code) => {
        const wasReady = this.ready;
        this.ready = false;
        this.worker = null;
        for (const [, cb] of this.pending) {
          cb.reject(new Error('STT worker exited'));
        }
        this.pending.clear();
        if (!wasReady) {
          const detail = stderrBuf ? `: ${stderrBuf.trim().split('\n').pop()}` : '';
          reject(new Error(`STT worker exited with code ${code}${detail}`));
        }
      });
    });

    return this._readyPromise;
  }

  /**
   * Recognize speech from a WAV buffer (16-bit PCM, mono).
   * @param {Buffer} wavBuffer - WAV file buffer
   * @returns {Promise<string>} recognized text
   */
  async recognize(wavBuffer) {
    await this.init();

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      this.worker.send({
        type: 'recognize',
        id,
        wavBase64: wavBuffer.toString('base64'),
        sampleRate: this.sampleRate,
      });

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('STT recognition timeout'));
        }
      }, 30000);
    });
  }

  close() {
    if (this.worker) {
      try { this.worker.kill(); } catch {}
      this.worker = null;
      this.ready = false;
    }
  }
}

module.exports = LocalSTT;
