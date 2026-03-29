const { spawn } = require('child_process');
const EventEmitter = require('events');

function getFFmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

// ═══════════════════════════════════════════
// VAD — Voice Activity Detection
// Анализ амплитуды PCM-потока в реальном времени
// ═══════════════════════════════════════════

class VAD extends EventEmitter {
  constructor(config = {}) {
    super();
    this.device = config.device || null;
    this.sampleRate = config.sampleRate || 16000;
    this.threshold = config.threshold || 500;       // порог амплитуды (0-32767)
    this.silenceMs = config.silenceMs || 1500;       // мс тишины для окончания фразы
    this.minSpeechMs = config.minSpeechMs || 300;    // мин. длительность речи
    this.maxSpeechMs = config.maxSpeechMs || 15000;  // макс. длительность фразы
    this.prefixMs = config.prefixMs || 300;          // сколько мс до начала речи сохранять

    this.ffmpegPath = getFFmpegPath();
    this._process = null;
    this._active = false;

    // Состояние
    this._speaking = false;
    this._silenceStart = 0;
    this._speechStart = 0;
    this._chunks = [];
    this._prefixBuffer = [];  // кольцевой буфер для prefix
    this._prefixBytes = Math.floor(this.sampleRate * 2 * (this.prefixMs / 1000));
  }

  // Запустить VAD-прослушивание
  async start() {
    if (this._active) return;

    let deviceName = this.device;
    if (!deviceName) {
      throw new Error('VAD: устройство не указано');
    }

    this._active = true;
    this._speaking = false;
    this._chunks = [];
    this._prefixBuffer = [];

    this._process = spawn(this.ffmpegPath, [
      '-y',
      '-f', 'dshow',
      '-i', `audio=${deviceName}`,
      '-ar', String(this.sampleRate),
      '-ac', '1',
      '-sample_fmt', 's16',
      '-f', 's16le',
      'pipe:1'
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this._process.stdout.on('data', (chunk) => {
      this._analyzeChunk(chunk);
    });

    this._process.on('error', (err) => {
      this._active = false;
      this.emit('error', err);
    });

    this._process.on('close', () => {
      this._active = false;
      // Если была речь — финализируем
      if (this._speaking && this._chunks.length > 0) {
        this._finalizeSpeech();
      }
    });

    this.emit('started');
  }

  // Анализ PCM-чанка
  _analyzeChunk(chunk) {
    if (!this._active) return;

    // Вычисляем RMS амплитуду
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length >> 1);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();

    if (rms > this.threshold) {
      // Обнаружена речь
      if (!this._speaking) {
        this._speaking = true;
        this._speechStart = now;
        this._silenceStart = 0;

        // Добавляем prefix (аудио до начала речи)
        if (this._prefixBuffer.length > 0) {
          this._chunks.push(...this._prefixBuffer);
          this._prefixBuffer = [];
        }

        this.emit('speechStart');
      }
      this._silenceStart = 0;
      this._chunks.push(chunk);
    } else {
      // Тишина
      if (this._speaking) {
        this._chunks.push(chunk); // продолжаем записывать во время пауз

        if (this._silenceStart === 0) {
          this._silenceStart = now;
        }

        const silenceDuration = now - this._silenceStart;
        const speechDuration = now - this._speechStart;

        // Фраза закончилась?
        if (silenceDuration >= this.silenceMs) {
          if (speechDuration >= this.minSpeechMs) {
            this._finalizeSpeech();
          } else {
            // Слишком короткий фрагмент — шум, игнорируем
            this._resetSpeech();
          }
        }

        // Превышена максимальная длительность
        if (speechDuration >= this.maxSpeechMs) {
          this._finalizeSpeech();
        }
      } else {
        // Не говорят — обновляем prefix-буфер
        this._prefixBuffer.push(chunk);
        // Обрезаем prefix-буфер по размеру
        let totalLen = 0;
        for (const c of this._prefixBuffer) totalLen += c.length;
        while (totalLen > this._prefixBytes && this._prefixBuffer.length > 1) {
          totalLen -= this._prefixBuffer.shift().length;
        }
      }
    }
  }

  _finalizeSpeech() {
    const pcmData = Buffer.concat(this._chunks);
    this._resetSpeech();

    if (pcmData.length < this.sampleRate * 2 * (this.minSpeechMs / 1000)) {
      return; // слишком мало данных
    }

    // Формируем WAV
    const wavBuffer = this._pcmToWav(pcmData);
    this.emit('speech', wavBuffer);
  }

  _resetSpeech() {
    this._speaking = false;
    this._speechStart = 0;
    this._silenceStart = 0;
    this._chunks = [];
  }

  _pcmToWav(pcmData) {
    const header = Buffer.alloc(44);
    const dataLength = pcmData.length;
    const sampleRate = this.sampleRate;
    const bitsPerSample = 16;
    const byteRate = sampleRate * (bitsPerSample / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    return Buffer.concat([header, pcmData]);
  }

  // Остановить VAD
  stop() {
    this._active = false;
    if (this._process) {
      try { this._process.stdin.write('q'); } catch {}
      setTimeout(() => {
        if (this._process) {
          try { this._process.kill('SIGKILL'); } catch {}
          this._process = null;
        }
      }, 1000);
    }
    this._resetSpeech();
    this.emit('stopped');
  }

  get isActive() {
    return this._active;
  }

  get isSpeaking() {
    return this._speaking;
  }
}

module.exports = VAD;
