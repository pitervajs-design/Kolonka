const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getFFmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

class Player {
  constructor(config = {}) {
    this.process = null;
    this.tempFile = path.join(os.tmpdir(), `kolonka_ai_${process.pid}.wav`);
    this.ffmpegPath = getFFmpegPath();
    this.outputDevice = config.outputDevice || null;
  }

  // Установить устройство вывода
  setOutputDevice(deviceName) {
    this.outputDevice = deviceName;
  }

  // WAV-заголовок для raw PCM
  _createWavHeader(dataLength, sampleRate, channels = 1, bitsPerSample = 16) {
    const header = Buffer.alloc(44);
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

    return header;
  }

  // Воспроизвести raw PCM буфер
  async playPcm(pcmBuffer, sampleRate = 24000) {
    const header = this._createWavHeader(pcmBuffer.length, sampleRate);
    const wavBuffer = Buffer.concat([header, pcmBuffer]);
    return this.playWav(wavBuffer);
  }

  // Воспроизвести MP3-буфер (конвертирует в WAV через ffmpeg)
  async playMp3(mp3Buffer) {
    const mp3File = this.tempFile.replace(/\.wav$/, '.mp3');
    fs.writeFileSync(mp3File, mp3Buffer);

    // Конвертируем MP3 → WAV через ffmpeg
    await new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, [
        '-y', '-i', mp3File, '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', this.tempFile
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (code) => {
        try { fs.unlinkSync(mp3File); } catch {}
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg convert failed (code ${code})`));
      });
      proc.on('error', reject);
    });

    return this._playFile(this.tempFile);
  }

  // Воспроизвести WAV-буфер
  async playWav(wavBuffer) {
    fs.writeFileSync(this.tempFile, wavBuffer);
    return this._playFile(this.tempFile);
  }

  // Воспроизвести через ffmpeg (кроссплатформенно, с выбором устройства)
  _playFile(filePath) {
    return new Promise((resolve, reject) => {
      const args = ['-y', '-i', filePath];

      if (this.outputDevice) {
        // Выводим на конкретное устройство (DirectSound на Windows)
        args.push('-f', 'dshow', '-i', `audio=${this.outputDevice}`);
      } else {
        // Стандартный вывод — через SDL или системный
        // ffplay не требует указания устройства
        // Используем PowerShell как надёжный fallback на Windows
        return this._playFilePowerShell(filePath).then(resolve, reject);
      }

      // ffplay для воспроизведения (входит в ffmpeg)
      const ffplayPath = this.ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffplay$1');

      this.process = spawn(ffplayPath, [
        '-nodisp', '-autoexit', '-i', filePath
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.process.on('close', (code) => {
        this.process = null;
        resolve(); // Всегда resolve — ffplay может вернуть ненулевой код
      });

      this.process.on('error', () => {
        // ffplay не найден — fallback на PowerShell
        this.process = null;
        this._playFilePowerShell(filePath).then(resolve, reject);
      });
    });
  }

  // PowerShell fallback для Windows
  _playFilePowerShell(filePath) {
    return new Promise((resolve, reject) => {
      const absPath = path.resolve(filePath).replace(/\\/g, '\\\\');
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $player = New-Object System.Media.SoundPlayer "${absPath}"
        $player.PlaySync()
      `;

      this.process = spawn('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', script
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.process.on('close', (code) => {
        this.process = null;
        if (code === 0) resolve();
        else reject(new Error(`Ошибка воспроизведения (код ${code})`));
      });

      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`PowerShell не найден: ${err.message}`));
      });
    });
  }

  stop() {
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
  }

  cleanup() {
    this.stop();
    try { fs.unlinkSync(this.tempFile); } catch {}
  }
}

module.exports = Player;
