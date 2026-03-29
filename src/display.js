let Divoom;
try {
  Divoom = require('node-divoom-timebox-evo');
} catch {
  Divoom = null;
}

let SerialPortModule;
try {
  SerialPortModule = require('serialport');
} catch {
  SerialPortModule = null;
}

const AnimationEngine = require('./animations');
const { icons, emotions } = require('./pixel-art');

class Display {
  constructor(config = {}) {
    this.port = null;
    this.comPort = config.comPort || null;
    this.baudRate = config.baudRate || 115200;
    this.brightness = config.brightness != null ? config.brightness : 80;
    this.connected = false;
    this.timebox = null;
    this.animation = new AnimationEngine();
    this._reconnectTimer = null;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reconnectIntervals = [5000, 10000, 30000, 60000]; // экспоненциальный backoff
  }

  async connect() {
    if (!this.comPort) {
      console.log('  [Display] COM-порт не указан, дисплей отключён');
      return false;
    }

    if (!Divoom) {
      console.log('  [Display] node-divoom-timebox-evo не установлен');
      return false;
    }

    if (!SerialPortModule) {
      console.log('  [Display] serialport не установлен');
      return false;
    }

    try {
      this.timebox = new Divoom.TimeboxEvo();
      const { SerialPort } = SerialPortModule;

      this.port = new SerialPort({
        path: this.comPort,
        baudRate: this.baudRate,
      });

      return new Promise((resolve) => {
        this.port.on('open', async () => {
          this.connected = true;
          this._reconnecting = false;
          console.log(`  [Display] Подключено к ${this.comPort}`);
          // Установить яркость
          try { await this.setBrightness(this.brightness); } catch {}
          resolve(true);
        });

        this.port.on('error', (err) => {
          console.error(`  [Display] Ошибка: ${err.message}`);
          this.connected = false;
          this._scheduleReconnect();
          resolve(false);
        });

        this.port.on('close', () => {
          if (this.connected) {
            console.log('  [Display] Соединение потеряно');
            this.connected = false;
            this._scheduleReconnect();
          }
        });
      });
    } catch (err) {
      console.error(`  [Display] Ошибка подключения: ${err.message}`);
      return false;
    }
  }

  _scheduleReconnect() {
    if (this._reconnecting || !this.comPort) return;
    this._reconnecting = true;

    const delay = this._reconnectIntervals[
      Math.min(this._reconnectAttempt, this._reconnectIntervals.length - 1)
    ];
    this._reconnectAttempt++;

    console.log(`  [Display] Переподключение через ${delay / 1000}с (попытка ${this._reconnectAttempt})...`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnecting = false;
      try {
        if (this.port) {
          try { this.port.close(); } catch {}
        }
        this.port = null;
        const ok = await this.connect();
        if (ok) {
          this._reconnectAttempt = 0;
          console.log('  [Display] Переподключение успешно!');
        } else {
          this._scheduleReconnect(); // следующая попытка
        }
      } catch {
        this._scheduleReconnect();
      }
    }, delay);
  }

  // Отправить буферы в Timebox (с rate limiting)
  async _sendBuffers(buffers) {
    if (!this.connected || !this.port) return;

    for (const buf of buffers) {
      await new Promise((resolve, reject) => {
        this.port.write(buf, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise(r => setTimeout(r, 35));
    }
  }

  // Отправить пиксельное изображение 16x16
  async showPixels(pixelIndices, colors) {
    if (!this.connected || !this.timebox) return;

    try {
      const d = this.timebox.createRequest('raw');

      const numColors = colors.length;
      let colorData = '';
      for (const [r, g, b] of colors) {
        colorData += this._toHex(r) + this._toHex(g) + this._toHex(b);
      }

      const bitsPerPixel = Math.ceil(Math.log2(numColors || 2));
      let pixelBits = '';
      for (let i = 0; i < 256; i++) {
        const idx = pixelIndices[i] || 0;
        pixelBits += idx.toString(2).padStart(bitsPerPixel, '0');
      }

      let pixelData = '';
      for (let i = 0; i < pixelBits.length; i += 8) {
        const byte = pixelBits.slice(i, i + 8).split('').reverse().join('');
        pixelData += parseInt(byte, 2).toString(16).padStart(2, '0');
      }

      const totalLength = colorData.length / 2 + pixelData.length / 2;
      const hexPayload = '44' + '00' + '0A0A04' +
        'AA' +
        this._toLEHex16(totalLength) +
        '000000' +
        this._toHex(numColors) +
        colorData +
        pixelData;

      d.push(hexPayload);
      const buffers = d.messages.asBinaryBuffer();
      await this._sendBuffers(buffers);
    } catch {}
  }

  // Установить яркость (0-100)
  async setBrightness(level) {
    if (!this.connected || !this.timebox) return;
    try {
      const d = this.timebox.createRequest('raw');
      d.push('74' + this._toHex(Math.min(100, Math.max(0, level))));
      const buffers = d.messages.asBinaryBuffer();
      await this._sendBuffers(buffers);
    } catch {}
  }

  // Показать состояние (с анимацией)
  async showState(state) {
    const onFrame = async (frame) => {
      await this.showPixels(frame.pixels, frame.colors);
    };

    // Запуск анимации/статики через AnimationEngine
    this.animation.start(state, onFrame);

    // Для состояний без анимации показываем статическую иконку
    if (!this.animation.isRunning && icons[state]) {
      const frame = icons[state]();
      await this.showPixels(frame.pixels, frame.colors);
    }
  }

  // Показать эмоцию (на 3 секунды, потом вернуть предыдущее состояние)
  async showEmotion(emotionName, durationMs = 3000) {
    const emotionFn = emotions[emotionName];
    if (!emotionFn) return;

    const prevState = this.animation.currentState;
    this.animation.stop();

    const frame = emotionFn();
    await this.showPixels(frame.pixels, frame.colors);

    if (durationMs > 0 && prevState) {
      setTimeout(() => {
        if (!this.animation.isRunning) {
          this.showState(prevState).catch(() => {});
        }
      }, durationMs);
    }
  }

  // Показать текст (прокрутка)
  async showText(text) {
    if (!this.connected || !this.timebox) return;

    this.animation.stop();

    try {
      const d = this.timebox.createRequest('text', { text });
      d.paletteFn = d.PALETTE_BLACK_ON_CMY_RAINBOW;
      d.animFn = d.ANIM_HORIZONTAL_GRADIANT_BACKGROUND;
      const buffers = d.messages.asBinaryBuffer();
      await this._sendBuffers(buffers);

      for (let i = 0; i < 80; i++) {
        const frame = d.getNextAnimationFrame().asBinaryBuffer();
        await this._sendBuffers(frame);
      }
    } catch {}
  }

  // Показать часы (режим ожидания)
  async showClock() {
    if (!this.connected || !this.timebox) return;

    this.animation.stop();

    try {
      const d = this.timebox.createRequest('raw');
      // Команда 0x450001 — показать часы
      d.push('450001');
      const buffers = d.messages.asBinaryBuffer();
      await this._sendBuffers(buffers);
    } catch {}
  }

  // Показать VJ-эффект
  async showVjEffect(effectId = 0) {
    if (!this.connected || !this.timebox) return;

    this.animation.stop();

    try {
      const d = this.timebox.createRequest('raw');
      d.push('4503' + this._toHex(effectId & 0xFF));
      const buffers = d.messages.asBinaryBuffer();
      await this._sendBuffers(buffers);
    } catch {}
  }

  static async listPorts() {
    if (!SerialPortModule) return [];
    try {
      const { SerialPort } = SerialPortModule;
      return await SerialPort.list();
    } catch {
      return [];
    }
  }

  _toHex(n) {
    return n.toString(16).padStart(2, '0');
  }

  _toLEHex16(n) {
    const lo = n & 0xFF;
    const hi = (n >> 8) & 0xFF;
    return this._toHex(lo) + this._toHex(hi);
  }

  async disconnect() {
    this.animation.stop();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.port && this.connected) {
      try { this.port.close(); } catch {}
      this.connected = false;
    }
  }
}

module.exports = Display;
