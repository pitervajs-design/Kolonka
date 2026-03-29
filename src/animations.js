const { animations, icons } = require('./pixel-art');

// FPS для каждого состояния
const STATE_FPS = {
  listening: 10,
  thinking: 12,
  speaking: 15,
  error: 5,
};

// Минимальный интервал между сообщениями (30 msg/sec → ~33ms)
const MIN_FRAME_INTERVAL = 35;

class AnimationEngine {
  constructor() {
    this._timer = null;
    this._generator = null;
    this._currentState = null;
    this._onFrame = null; // callback(frameData) => Promise
    this._running = false;
  }

  // Запуск анимации для заданного состояния
  // onFrame(frameData) — callback, который отправляет кадр на Timebox
  start(state, onFrame) {
    this.stop();

    this._currentState = state;
    this._onFrame = onFrame;

    // Если для этого состояния есть анимация — используем генератор
    if (animations[state]) {
      this._generator = animations[state]();
      this._running = true;

      const fps = STATE_FPS[state] || 10;
      const interval = Math.max(MIN_FRAME_INTERVAL, Math.floor(1000 / fps));

      this._tick(interval);
    } else if (icons[state]) {
      // Статическая иконка — один кадр
      const frame = icons[state]();
      if (this._onFrame) {
        this._onFrame(frame).catch(() => {});
      }
    }
  }

  async _tick(interval) {
    if (!this._running || !this._generator) return;

    const { value, done } = this._generator.next();
    if (done) {
      this.stop();
      return;
    }

    if (this._onFrame && value) {
      try {
        await this._onFrame(value);
      } catch {
        // Ошибка отправки кадра — продолжаем
      }
    }

    if (this._running) {
      this._timer = setTimeout(() => this._tick(interval), interval);
    }
  }

  // Показать один статический кадр (останавливает текущую анимацию)
  async showStatic(frameData, onFrame) {
    this.stop();
    if (onFrame) {
      await onFrame(frameData);
    } else if (this._onFrame) {
      await this._onFrame(frameData);
    }
  }

  // Остановить анимацию
  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._generator = null;
    this._currentState = null;
  }

  get currentState() {
    return this._currentState;
  }

  get isRunning() {
    return this._running;
  }
}

module.exports = AnimationEngine;
