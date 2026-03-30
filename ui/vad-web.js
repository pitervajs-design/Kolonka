// ═══════════════════════════════════════════
// WebVAD — Voice Activity Detection через Web Audio API
// Работает в renderer-процессе Electron (Chromium)
// ═══════════════════════════════════════════

class WebVAD {
  constructor(options = {}) {
    this.threshold = options.threshold || 200;        // порог RMS (0-32767 scale)
    this.silenceMs = options.silenceMs || 1500;       // мс тишины для окончания фразы
    this.minSpeechMs = options.minSpeechMs || 300;    // мин. длительность речи
    this.maxSpeechMs = options.maxSpeechMs || 15000;  // макс. длительность фразы
    this.prefixMs = options.prefixMs || 300;          // мс до начала речи сохранять

    this._stream = null;
    this._audioContext = null;
    this._source = null;
    this._processor = null;
    this._active = false;
    this._sampleRate = 16000; // будет обновлено после создания AudioContext

    // Состояние
    this._speaking = false;
    this._silenceStart = 0;
    this._speechStart = 0;
    this._chunks = [];          // Float32Array chunks
    this._prefixBuffer = [];
    this._prefixSamples = 0;    // пересчитается после start()

    // Callbacks
    this.onSpeechStart = null;
    this.onSpeech = null;       // WAV Buffer
    this.onDebug = null;
    this.onError = null;

    // Диагностика
    this._lastRms = 0;
    this._maxRms = 0;
    this._chunkCount = 0;
    this._rmsLogInterval = null;
  }

  async start() {
    if (this._active) return;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });

      // Попытка создать AudioContext на 16000 Hz (Chromium поддерживает)
      this._audioContext = new AudioContext({ sampleRate: 16000 });
      this._sampleRate = this._audioContext.sampleRate;
      this._prefixSamples = Math.floor(this._sampleRate * (this.prefixMs / 1000));

      this._source = this._audioContext.createMediaStreamSource(this._stream);

      // ScriptProcessorNode: 4096 samples per chunk
      this._processor = this._audioContext.createScriptProcessor(4096, 1, 1);

      this._processor.onaudioprocess = (e) => {
        if (!this._active) return;
        // Копируем данные (getChannelData возвращает view, не copy)
        const input = e.inputBuffer.getChannelData(0);
        this._analyzeChunk(new Float32Array(input));
      };

      this._source.connect(this._processor);
      this._processor.connect(this._audioContext.destination);

      this._active = true;
      this._speaking = false;
      this._chunks = [];
      this._prefixBuffer = [];

      this._startDiagnostics();

      if (this.onDebug) {
        this.onDebug(`[WebVAD] Запущен: sampleRate=${this._sampleRate} threshold=${this.threshold}`);
      }
    } catch (err) {
      this._cleanup();
      if (this.onError) this.onError(err);
      throw err;
    }
  }

  _analyzeChunk(samples) {
    this._chunkCount++;

    // RMS в масштабе 16-bit (0-32767) для совместимости с порогом
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const s16 = samples[i] * 32767;
      sum += s16 * s16;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();

    this._lastRms = rms;
    if (rms > this._maxRms) this._maxRms = rms;

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

        if (this.onSpeechStart) this.onSpeechStart();
      }
      this._silenceStart = 0;
      this._chunks.push(samples);
    } else {
      // Тишина
      if (this._speaking) {
        this._chunks.push(samples);

        if (this._silenceStart === 0) {
          this._silenceStart = now;
        }

        const silenceDuration = now - this._silenceStart;
        const speechDuration = now - this._speechStart;

        if (silenceDuration >= this.silenceMs) {
          if (speechDuration >= this.minSpeechMs) {
            this._finalizeSpeech();
          } else {
            this._resetSpeech();
          }
        }

        if (speechDuration >= this.maxSpeechMs) {
          this._finalizeSpeech();
        }
      } else {
        // Обновляем prefix-буфер
        this._prefixBuffer.push(samples);
        let totalSamples = 0;
        for (const c of this._prefixBuffer) totalSamples += c.length;
        while (totalSamples > this._prefixSamples && this._prefixBuffer.length > 1) {
          totalSamples -= this._prefixBuffer.shift().length;
        }
      }
    }
  }

  _finalizeSpeech() {
    // Подсчёт общего количества сэмплов
    let totalSamples = 0;
    for (const c of this._chunks) totalSamples += c.length;

    const minSamples = Math.floor(this._sampleRate * (this.minSpeechMs / 1000));
    if (totalSamples < minSamples) {
      this._resetSpeech();
      return;
    }

    // Конвертация Float32 → Int16 PCM
    const pcm = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of this._chunks) {
      for (let i = 0; i < c.length; i++) {
        pcm[offset++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
      }
    }

    this._resetSpeech();

    // Создаём WAV
    const wavBuffer = this._pcmToWav(pcm);

    if (this.onDebug) {
      this.onDebug(`[WebVAD] Фраза: ${totalSamples} samples, ${Math.round(wavBuffer.byteLength / 1024)}KB`);
    }

    if (this.onSpeech) this.onSpeech(wavBuffer);
  }

  _resetSpeech() {
    this._speaking = false;
    this._speechStart = 0;
    this._silenceStart = 0;
    this._chunks = [];
  }

  _pcmToWav(pcmInt16) {
    const dataLength = pcmInt16.length * 2;
    const sampleRate = this._sampleRate;
    const bitsPerSample = 16;
    const channels = 1;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF header
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);        // fmt chunk size
    view.setUint16(20, 1, true);         // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // PCM data
    const wavBytes = new Uint8Array(buffer);
    wavBytes.set(new Uint8Array(pcmInt16.buffer), 44);

    return wavBytes;

    function writeStr(dv, off, str) {
      for (let i = 0; i < str.length; i++) {
        dv.setUint8(off + i, str.charCodeAt(i));
      }
    }
  }

  // Пауза VAD (AudioContext suspend — без освобождения микрофона)
  async pause() {
    if (this._audioContext && this._active) {
      this._resetSpeech();
      await this._audioContext.suspend();
      this._stopDiagnostics();
      if (this.onDebug) this.onDebug('[WebVAD] Пауза');
    }
  }

  // Возобновление VAD
  async resume() {
    if (this._audioContext && this._active) {
      await this._audioContext.resume();
      this._startDiagnostics();
      if (this.onDebug) this.onDebug('[WebVAD] Возобновлён');
    }
  }

  stop() {
    this._active = false;
    this._stopDiagnostics();
    this._resetSpeech();
    this._cleanup();
    if (this.onDebug) this.onDebug('[WebVAD] Остановлен');
  }

  _cleanup() {
    if (this._processor) {
      try { this._processor.disconnect(); } catch {}
      this._processor = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch {}
      this._source = null;
    }
    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
  }

  _startDiagnostics() {
    this._maxRms = 0;
    this._chunkCount = 0;
    this._rmsLogInterval = setInterval(() => {
      if (this.onDebug) {
        this.onDebug(`[WebVAD-RMS] last=${Math.round(this._lastRms)} max=${Math.round(this._maxRms)} threshold=${this.threshold} chunks=${this._chunkCount} speaking=${this._speaking}`);
      }
      this._maxRms = 0;
      this._chunkCount = 0;
    }, 5000);
  }

  _stopDiagnostics() {
    if (this._rmsLogInterval) {
      clearInterval(this._rmsLogInterval);
      this._rmsLogInterval = null;
    }
  }

  get isActive() {
    return this._active;
  }

  get isSpeaking() {
    return this._speaking;
  }
}

module.exports = WebVAD;
