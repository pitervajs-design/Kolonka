// Скрипт для отображения доступных устройств и проверки режимов
require('dotenv').config();
const DeviceManager = require('../src/devices');

let Display;
try {
  Display = require('../src/display');
} catch {}

async function main() {
  console.log('');
  console.log('=== Kolonka AI v2 — Список устройств ===');
  console.log('');

  const dm = new DeviceManager();

  // Аудио-устройства
  const devices = await dm.discoverAudioDevices();

  if (devices.all.length > 0) {
    console.log('Микрофоны (для MIC_DEVICE в .env):');
    devices.all.forEach((d, i) => {
      const isHfp = devices.hfpMics.includes(d);
      const tag = isHfp ? ' [HFP Bluetooth]' : '';
      console.log(`  ${i + 1}. ${d}${tag}`);
    });
  } else {
    console.log('Микрофоны: не найдены');
    console.log('  Убедитесь что ffmpeg установлен');
  }

  if (devices.hfpOutputs.length > 0) {
    console.log('');
    console.log('HFP-выходы (Bluetooth Hands-Free):');
    devices.hfpOutputs.forEach((d, i) => {
      console.log(`  ${i + 1}. ${d}`);
    });
  }

  console.log('');

  // COM-порты
  const ports = await dm.discoverSerialPorts();
  if (ports.length > 0) {
    console.log('COM-порты (для TIMEBOX_COM_PORT в .env):');
    ports.forEach(p => {
      const tag = p.isTimebox ? ' [Timebox?]' : '';
      const mfr = p.manufacturer ? ` | ${p.manufacturer}` : '';
      console.log(`  ${p.path}${mfr}${tag}`);
    });
  } else {
    console.log('COM-порты: не найдены');
    console.log('  Сопрягите Timebox Evo через Windows Bluetooth');
  }

  // Проверка режимов
  console.log('');
  console.log('Доступные режимы аудио:');

  for (const mode of ['timebox', 'hybrid', 'pc']) {
    const v = await dm.validateAudioMode(mode);
    const status = v.valid ? '[OK]' : '[--]';
    let info = '';
    if (!v.valid && v.warnings.length > 0) {
      info = ` (${v.warnings[0]})`;
    }
    console.log(`  ${status} ${mode}${info}`);
  }

  console.log('');
  const currentMode = process.env.AUDIO_MODE || 'pc';
  console.log(`Текущий режим: AUDIO_MODE=${currentMode}`);
  console.log('');
}

main().catch(console.error);
