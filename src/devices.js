const { spawn } = require('child_process');

let SerialPortModule;
try {
  SerialPortModule = require('serialport');
} catch {
  SerialPortModule = null;
}

function getFFmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

// Паттерны для определения типа аудио-устройства
const HFP_PATTERNS = [
  'hands-free',
  'handsfree',
  'hfp',
  'timebox',
  'divoom',
  'bluetooth.*ag audio',
];

const TIMEBOX_COM_PATTERNS = [
  'standard serial over bluetooth',
  'bluetooth',
];

class DeviceManager {
  constructor() {
    this.ffmpegPath = getFFmpegPath();
    this._cachedDevices = null;
    this._cachedPorts = null;
  }

  // Получить все аудио-устройства через ffmpeg dshow
  async discoverAudioDevices() {
    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, [
        '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
      ], { windowsHide: true });

      let output = '';
      proc.stderr.on('data', (data) => { output += data.toString('utf8'); });
      proc.on('close', () => {
        const devices = { all: [], hfpMics: [], pcMics: [], hfpOutputs: [] };
        const lines = output.split('\n');

        // Парсим устройства вывода (DirectShow output)
        let isOutputSection = false;
        for (const line of lines) {
          if (line.includes('Alternative name')) continue;

          // Определяем секцию вывода
          if (line.includes('DirectShow audio output')) {
            isOutputSection = true;
            continue;
          }
          if (line.includes('DirectShow') && !line.includes('audio output')) {
            isOutputSection = false;
          }

          const match = line.match(/"([^"]+)"\s*\(audio\)/);
          if (!match) continue;

          const name = match[1];
          const isHfp = HFP_PATTERNS.some(p => new RegExp(p, 'i').test(name));

          if (isOutputSection) {
            if (isHfp) devices.hfpOutputs.push(name);
            continue;
          }

          // Входные устройства (микрофоны)
          devices.all.push(name);
          if (isHfp) {
            devices.hfpMics.push(name);
          } else {
            devices.pcMics.push(name);
          }
        }

        this._cachedDevices = devices;
        resolve(devices);
      });
      proc.on('error', () => resolve({ all: [], hfpMics: [], pcMics: [], hfpOutputs: [] }));
    });
  }

  // Получить COM-порты
  async discoverSerialPorts() {
    if (!SerialPortModule) return [];
    try {
      const { SerialPort } = SerialPortModule;
      const ports = await SerialPort.list();
      this._cachedPorts = ports;

      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        isTimebox: TIMEBOX_COM_PATTERNS.some(pat =>
          new RegExp(pat, 'i').test(p.manufacturer || '') ||
          new RegExp(pat, 'i').test(p.pnpId || '')
        ),
        raw: p,
      }));
    } catch {
      return [];
    }
  }

  // Валидация выбранного аудио-режима
  // Возвращает { valid, warnings, mode }
  async validateAudioMode(mode) {
    const devices = this._cachedDevices || await this.discoverAudioDevices();
    const result = { valid: true, warnings: [], mode, fallbackMode: null };

    switch (mode) {
      case 'timebox':
        if (devices.hfpMics.length === 0) {
          result.valid = false;
          result.warnings.push(
            'HFP-микрофон Timebox Evo не найден.',
            'Убедитесь что Timebox подключён по Bluetooth и включён профиль Hands-Free.',
            'В настройках Windows звука устройство должно быть активно.'
          );
          result.fallbackMode = devices.pcMics.length > 0 ? 'pc' : null;
        }
        if (devices.hfpOutputs.length === 0) {
          result.warnings.push(
            'HFP-выход Timebox не найден. Звук будет воспроизводиться на устройстве по умолчанию.'
          );
        }
        break;

      case 'hybrid':
        if (devices.pcMics.length === 0) {
          result.valid = false;
          result.warnings.push('PC-микрофон не найден для гибридного режима.');
          result.fallbackMode = devices.hfpMics.length > 0 ? 'timebox' : null;
        }
        break;

      case 'pc':
        if (devices.pcMics.length === 0 && devices.all.length === 0) {
          result.valid = false;
          result.warnings.push('Микрофоны не найдены.');
        }
        break;

      default:
        result.valid = false;
        result.warnings.push(`Неизвестный режим: ${mode}. Допустимые: timebox, hybrid, pc`);
    }

    return result;
  }

  // Получить устройство записи для заданного режима
  async getRecordingDevice(mode) {
    const devices = this._cachedDevices || await this.discoverAudioDevices();

    switch (mode) {
      case 'timebox':
        return {
          name: devices.hfpMics[0] || null,
          sampleRate: 16000, // HFP обычно 16kHz или 8kHz
          type: 'hfp',
        };

      case 'hybrid':
        return {
          name: devices.pcMics[0] || devices.all[0] || null,
          sampleRate: 16000,
          type: 'pc',
        };

      case 'pc':
      default:
        return {
          name: devices.pcMics[0] || devices.all[0] || null,
          sampleRate: 16000,
          type: 'pc',
        };
    }
  }

  // Получить устройство воспроизведения для заданного режима
  getPlaybackDevice(mode) {
    const devices = this._cachedDevices;

    switch (mode) {
      case 'timebox':
        // A2DP через системный вывод по умолчанию (Bluetooth A2DP stereo)
        return { name: null, type: 'default' };

      case 'hybrid':
        // A2DP stereo — стерео Bluetooth
        return { name: null, type: 'default' };

      case 'pc':
      default:
        return { name: null, type: 'default' };
    }
  }

  // Красивый вывод информации об устройствах
  printDeviceReport(devices, ports) {
    console.log('');
    console.log('  ┌─── Аудио-устройства ───────────────────┐');

    if (devices.all.length === 0) {
      console.log('  │  Микрофоны не найдены                   │');
    } else {
      devices.all.forEach((d, i) => {
        const isHfp = devices.hfpMics.includes(d);
        const tag = isHfp ? ' [HFP]' : '      ';
        const line = `  ${i + 1}. ${d}${tag}`;
        console.log(`  │ ${line}`);
      });
    }

    if (devices.hfpOutputs.length > 0) {
      console.log('  │');
      console.log('  │  HFP-выходы:');
      devices.hfpOutputs.forEach(d => {
        console.log(`  │    ${d}`);
      });
    }

    console.log('  └──────────────────────────────────────────┘');

    if (ports && ports.length > 0) {
      console.log('  ┌─── COM-порты ─────────────────────────────┐');
      ports.forEach(p => {
        const tag = p.isTimebox ? ' [Timebox?]' : '';
        console.log(`  │  ${p.path} ${p.manufacturer}${tag}`);
      });
      console.log('  └──────────────────────────────────────────┘');
    }
  }
}

module.exports = DeviceManager;
