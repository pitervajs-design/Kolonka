const { spawn } = require('child_process');

function getFFmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

class Recorder {
  constructor(config = {}) {
    this.sampleRate = config.sampleRate || 16000;
    this.channels = 1;
    this.device = config.device || null;
    this.maxSeconds = config.maxSeconds || 30;
    this.process = null;
    this.chunks = [];
    this.ffmpegPath = getFFmpegPath();
  }

  // Установить устройство записи (вызывается DeviceManager)
  setDevice(deviceName, sampleRate) {
    this.device = deviceName;
    if (sampleRate) this.sampleRate = sampleRate;
  }

  // Получить список аудио-устройств (Windows dshow)
  async listDevices() {
    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, [
        '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
      ], { windowsHide: true });

      let output = '';
      proc.stderr.on('data', (data) => { output += data.toString('utf8'); });
      proc.on('close', () => {
        const devices = [];
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.includes('Alternative name')) continue;
          const match = line.match(/"([^"]+)"\s*\(audio\)/);
          if (match) {
            devices.push(match[1]);
          }
        }
        resolve(devices);
      });
      proc.on('error', () => resolve([]));
    });
  }

  // Автоопределение первого доступного микрофона
  async autoDetectDevice() {
    const devices = await this.listDevices();
    if (devices.length > 0) return devices[0];
    return null;
  }

  // Начать запись
  async startRecording() {
    if (this.process) {
      throw new Error('Уже идёт запись');
    }

    let deviceName = this.device;
    if (!deviceName) {
      deviceName = await this.autoDetectDevice();
      if (!deviceName) {
        throw new Error('Микрофон не найден. Укажите MIC_DEVICE в .env или проверьте AUDIO_MODE');
      }
    }

    this.chunks = [];

    return new Promise((resolve, reject) => {
      this.process = spawn(this.ffmpegPath, [
        '-y',
        '-f', 'dshow',
        '-i', `audio=${deviceName}`,
        '-ar', String(this.sampleRate),
        '-ac', String(this.channels),
        '-sample_fmt', 's16',
        '-t', String(this.maxSeconds),
        '-f', 's16le',
        'pipe:1'
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.stdout.on('data', (chunk) => {
        this.chunks.push(chunk);
      });

      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`ffmpeg не найден: ${err.message}`));
      });

      const checkTimer = setTimeout(() => {
        if (this.process && !this.process.killed) {
          resolve();
        }
      }, 800);

      this.process.on('close', (code) => {
        clearTimeout(checkTimer);
        this.process = null;
      });
    });
  }

  // Остановить запись и вернуть WAV-буфер
  async stopRecording() {
    if (!this.process) {
      throw new Error('Запись не ведётся');
    }

    return new Promise((resolve, reject) => {
      const onClose = () => {
        this.process = null;
        const pcmData = Buffer.concat(this.chunks);
        this.chunks = [];

        if (pcmData.length === 0) {
          reject(new Error('Пустая запись — микрофон не захватил звук'));
          return;
        }

        const wavBuffer = this._pcmToWav(pcmData);
        resolve(wavBuffer);
      };

      this.process.on('close', onClose);

      try {
        this.process.stdin.write('q');
      } catch {
        try { this.process.kill('SIGTERM'); } catch {}
      }

      setTimeout(() => {
        if (this.process) {
          try { this.process.kill('SIGKILL'); } catch {}
        }
      }, 3000);
    });
  }

  // Преобразование raw PCM в WAV
  _pcmToWav(pcmData) {
    const header = Buffer.alloc(44);
    const dataLength = pcmData.length;
    const sampleRate = this.sampleRate;
    const channels = this.channels;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    return Buffer.concat([header, pcmData]);
  }

  forceStop() {
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch {}
      this.process = null;
      this.chunks = [];
    }
  }
}

module.exports = Recorder;
