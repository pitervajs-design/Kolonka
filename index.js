require('dotenv').config();
const readline = require('readline');
const DeviceManager = require('./src/devices');
const Recorder = require('./src/recorder');
const Player = require('./src/player');
const AI = require('./src/ai');
const Display = require('./src/display');
const History = require('./src/history');
const VAD = require('./src/vad');
const CommandParser = require('./src/commands');

// ═══════════════════════════════════════════
// Конфигурация
// ═══════════════════════════════════════════

if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'sk-or-ВСТАВЬТЕ_ВАШ_КЛЮЧ_СЮДА') {
  console.error('');
  console.error('  OPENROUTER_API_KEY не указан.');
  console.error('  Скопируйте .env.example в .env и вставьте ваш ключ.');
  console.error('  Получить: https://openrouter.ai/keys');
  console.error('');
  process.exit(1);
}

const AUDIO_MODE = process.env.AUDIO_MODE || 'timebox';
const AI_MODE = process.env.AI_MODE || 'audio';
const IDLE_DISPLAY = process.env.IDLE_DISPLAY || 'icon';
const WAKE_WORD_ENABLED = (process.env.WAKE_WORD || 'true') !== 'false';
const VAD_THRESHOLD = parseInt(process.env.VAD_THRESHOLD) || 500;
const VAD_SILENCE_MS = parseInt(process.env.VAD_SILENCE_MS) || 1500;

// ═══════════════════════════════════════════
// Инициализация модулей
// ═══════════════════════════════════════════

const deviceManager = new DeviceManager();
const commandParser = new CommandParser();

const recorder = new Recorder({
  device: process.env.MIC_DEVICE || null,
  sampleRate: parseInt(process.env.RECORD_SAMPLE_RATE) || 16000,
  maxSeconds: parseInt(process.env.MAX_RECORD_SECONDS) || 30,
});

const player = new Player();

const ai = new AI({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.AI_MODEL || 'openai/gpt-4o-audio-preview',
  voice: process.env.AI_VOICE || 'nova',
  systemPrompt: process.env.SYSTEM_PROMPT || undefined,
  playbackSampleRate: parseInt(process.env.PLAYBACK_SAMPLE_RATE) || 24000,
  aiMode: AI_MODE,
  llmModel: process.env.LLM_MODEL || 'openai/gpt-4o',
});

const display = new Display({
  comPort: process.env.TIMEBOX_COM_PORT || null,
  baudRate: parseInt(process.env.TIMEBOX_BAUD_RATE) || 115200,
  brightness: parseInt(process.env.DISPLAY_BRIGHTNESS) || 80,
});

const history = new History({
  maxMessages: parseInt(process.env.MAX_HISTORY) || 50,
});

ai.setHistory(history);

// VAD создадим позже, когда узнаем устройство
let vad = null;
let vadMode = false; // PTT по умолчанию, VAD по клавише V

// ═══════════════════════════════════════════
// Состояния
// ═══════════════════════════════════════════

let state = 'idle';
let busy = false;

async function setState(newState) {
  state = newState;
  try {
    const displayState = newState === 'idle' ? 'ready' : newState;
    await display.showState(displayState);
  } catch {}
}

async function showIdleDisplay() {
  try {
    switch (IDLE_DISPLAY) {
      case 'clock': await display.showClock(); break;
      case 'vj':    await display.showVjEffect(0); break;
      default:      await display.showState('ready');
    }
  } catch {}
}

// ═══════════════════════════════════════════
// Обработка голосовых команд
// ═══════════════════════════════════════════

async function executeCommand(parsed) {
  const { handler, params } = parsed;
  console.log(`\r  [CMD] ${parsed.command.description}`);

  switch (handler) {
    case 'showClock':
      await display.showClock();
      break;
    case 'setBrightness':
      await display.setBrightness(params.level);
      console.log(`  Яркость: ${params.level}%`);
      break;
    case 'showVjEffect':
      await display.showVjEffect(params.effectId);
      console.log(`  Эффект: ${params.effectId}`);
      break;
    case 'showText':
      await display.showText(params.text);
      break;
    case 'clearHistory':
      ai.clearHistory();
      console.log('  История очищена.');
      break;
    case 'stop':
      player.stop();
      await showIdleDisplay();
      console.log('  Остановлено.');
      break;
    default:
      console.log(`  Неизвестная команда: ${handler}`);
  }
}

// ═══════════════════════════════════════════
// Обработка аудио (общая логика)
// ═══════════════════════════════════════════

async function processAudioBuffer(wavBuffer, fromVAD = false) {
  if (busy) return;
  busy = true;

  try {
    await setState('processing');
    process.stdout.write('\r  [AI] Думаю...                          ');

    const result = await ai.processAudio(wavBuffer, {
      onTranscript: () => {},
      onUserTranscript: (text) => {
        console.log(`\r  Вы: ${text}                `);
      },
      onStage: (stage) => {
        const stageNames = { stt: 'Распознавание...', llm: 'Думаю...', tts: 'Озвучивание...' };
        process.stdout.write(`\r  [AI] ${stageNames[stage] || stage}                `);
      },
    });

    // Проверяем wake word (для VAD-режима)
    if (fromVAD && WAKE_WORD_ENABLED) {
      const transcript = result.transcript || result.userTranscript || '';
      if (!commandParser.containsWakeWord(transcript)) {
        // Нет wake word — игнорируем (если пришло из VAD)
        busy = false;
        return;
      }
      console.log('  [Джарвис] Активирован');
    }

    // Проверяем голосовые команды
    const textToCheck = result.userTranscript || result.transcript || '';
    const parsed = commandParser.parse(textToCheck);

    if (parsed.isCommand) {
      await executeCommand(parsed);
      await showIdleDisplay();
      state = 'idle';
      busy = false;
      if (!vadMode) printPrompt();
      return;
    }

    // Обычный ответ AI
    if (result.transcript) {
      console.log(`\r  AI: ${result.transcript}                `);
    }

    if (result.emotion && result.emotion !== 'neutral') {
      display.showEmotion(result.emotion, 2000).catch(() => {});
    }

    if (result.hasAudio && result.audioData.length > 0) {
      await setState('speaking');
      process.stdout.write('  [>>>] Воспроизведение...\n');
      const sampleRate = parseInt(process.env.PLAYBACK_SAMPLE_RATE) || 24000;
      await player.playPcm(result.audioData, sampleRate);
    } else if (result.transcript) {
      console.log('  (аудио-ответ недоступен, только текст)');
    } else {
      console.log('  (пустой ответ от AI)');
    }
  } catch (err) {
    console.error(`\n  Ошибка: ${err.message}`);
    await setState('error');
    await new Promise(r => setTimeout(r, 2000));
  }

  await showIdleDisplay();
  state = 'idle';
  busy = false;
  if (!vadMode) printPrompt();
}

// ═══════════════════════════════════════════
// Push-to-Talk (ПРОБЕЛ)
// ═══════════════════════════════════════════

async function onSpacePress() {
  if (vadMode) {
    // В VAD-режиме ПРОБЕЛ отключает VAD и переключает в PTT
    toggleVAD();
    return;
  }

  if (busy && state !== 'listening') return;

  if (state === 'idle') {
    busy = true;
    try {
      await setState('listening');
      process.stdout.write('\r  [REC] Запись... (ПРОБЕЛ = стоп)       ');
      await recorder.startRecording();
    } catch (err) {
      console.error(`\n  Ошибка записи: ${err.message}`);
      await setState('error');
      setTimeout(() => { showIdleDisplay(); }, 2000);
      busy = false;
      printPrompt();
    }
    return;
  }

  if (state === 'listening') {
    try {
      process.stdout.write('\r  Остановка записи...                    ');
      const wavBuffer = await recorder.stopRecording();
      await processAudioBuffer(wavBuffer, false);
    } catch (err) {
      console.error(`\n  Ошибка: ${err.message}`);
      await showIdleDisplay();
      state = 'idle';
      busy = false;
      printPrompt();
    }
    return;
  }
}

// ═══════════════════════════════════════════
// VAD-режим (клавиша V)
// ═══════════════════════════════════════════

function toggleVAD() {
  if (!vad) {
    console.log('\n  VAD недоступен — микрофон не настроен');
    printPrompt();
    return;
  }

  vadMode = !vadMode;

  if (vadMode) {
    // Если сейчас записываем PTT — останавливаем
    if (state === 'listening') {
      recorder.forceStop();
    }

    console.log('\n  [VAD] Включён — слушаю постоянно' +
      (WAKE_WORD_ENABLED ? ' (скажите "Джарвис")' : ''));

    vad.start().catch(err => {
      console.error(`  [VAD] Ошибка запуска: ${err.message}`);
      vadMode = false;
      printPrompt();
    });
  } else {
    vad.stop();
    console.log('\n  [VAD] Выключен — режим Push-to-Talk');
    state = 'idle';
    busy = false;
    printPrompt();
  }
}

function setupVAD(deviceName, sampleRate) {
  vad = new VAD({
    device: deviceName,
    sampleRate: sampleRate || 16000,
    threshold: VAD_THRESHOLD,
    silenceMs: VAD_SILENCE_MS,
  });

  vad.on('speechStart', () => {
    if (busy) return;
    process.stdout.write('\r  [VAD] Речь обнаружена...                ');
    setState('listening').catch(() => {});
  });

  vad.on('speech', async (wavBuffer) => {
    if (busy) return;
    process.stdout.write('\r  [VAD] Фраза записана, обработка...      ');
    await processAudioBuffer(wavBuffer, true);
  });

  vad.on('error', (err) => {
    console.error(`\n  [VAD] Ошибка: ${err.message}`);
  });
}

// ═══════════════════════════════════════════
// Интерфейс
// ═══════════════════════════════════════════

function printPrompt() {
  const modeLabel = vadMode ? 'VAD (V=PTT)' : 'PTT (V=VAD)';
  process.stdout.write(`\n  ПРОБЕЛ=запись | V=${vadMode ? 'выкл' : 'вкл'} VAD | Q=выход | C=очистить\n  [${modeLabel}] > `);
}

// ═══════════════════════════════════════════
// Настройка устройств
// ═══════════════════════════════════════════

async function setupDevices() {
  const devices = await deviceManager.discoverAudioDevices();
  const ports = await deviceManager.discoverSerialPorts();

  deviceManager.printDeviceReport(devices, ports);

  const validation = await deviceManager.validateAudioMode(AUDIO_MODE);

  let activeMode = AUDIO_MODE;
  if (!validation.valid) {
    console.log('');
    validation.warnings.forEach(w => console.log(`  ! ${w}`));
    if (validation.fallbackMode) {
      console.log(`  -> Переключение на режим: ${validation.fallbackMode}`);
      activeMode = validation.fallbackMode;
    }
  } else {
    validation.warnings.forEach(w => console.log(`  ! ${w}`));
  }

  // Настраиваем рекордер
  let recDeviceName = process.env.MIC_DEVICE || null;
  let recSampleRate = parseInt(process.env.RECORD_SAMPLE_RATE) || 16000;

  if (!recDeviceName) {
    const recDevice = await deviceManager.getRecordingDevice(activeMode);
    if (recDevice.name) {
      recDeviceName = recDevice.name;
      recSampleRate = recDevice.sampleRate;
      recorder.setDevice(recDeviceName, recSampleRate);
    }
  }

  // Настраиваем VAD с тем же устройством
  if (recDeviceName) {
    setupVAD(recDeviceName, recSampleRate);
  }

  return activeMode;
}

// ═══════════════════════════════════════════
// Запуск
// ═══════════════════════════════════════════

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║    Kolonka AI v2 — Умная колонка          ║');
  console.log('  ║    Divoom Timebox Evo + OpenRouter         ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  // Подключение к Timebox
  const timeboxOk = await display.connect();
  if (timeboxOk) {
    console.log('  Timebox Evo: подключён');
  } else {
    console.log('  Timebox Evo: не подключён (работаем без дисплея)');
  }

  // Настройка устройств
  const activeMode = await setupDevices();

  console.log('');
  console.log(`  Режим аудио:  ${activeMode}`);
  console.log(`  Режим AI:     ${AI_MODE}`);
  console.log(`  Модель:       ${process.env.AI_MODEL || 'openai/gpt-4o-audio-preview'}`);
  console.log(`  Голос:        ${process.env.AI_VOICE || 'nova'}`);
  console.log(`  Wake word:    ${WAKE_WORD_ENABLED ? 'Джарвис' : 'выключен'}`);
  console.log(`  История:      ${history.length} сообщений`);
  console.log('');
  console.log('  Голосовые команды:');
  console.log(commandParser.getHelpText());

  await showIdleDisplay();
  printPrompt();

  // ── Клавиатура ──
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on('keypress', async (str, key) => {
    if (!key) return;

    // Выход
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      console.log('\n  Выход...');
      if (vad) vad.stop();
      recorder.forceStop();
      player.cleanup();
      await display.disconnect();
      process.exit(0);
    }

    // VAD toggle
    if (key.name === 'v' && (state === 'idle' || vadMode)) {
      toggleVAD();
      return;
    }

    // Очистить историю
    if (key.name === 'c' && state === 'idle' && !busy) {
      ai.clearHistory();
      console.log('\r  История очищена.                        ');
      printPrompt();
      return;
    }

    // Push-to-talk
    if (key.name === 'space') {
      await onSpacePress();
    }
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    if (vad) vad.stop();
    recorder.forceStop();
    player.cleanup();
    await display.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Критическая ошибка:', err.message);
  process.exit(1);
});
