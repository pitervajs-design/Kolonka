require('dotenv').config();
const EventEmitter = require('events');
const DeviceManager = require('./devices');
const Recorder = require('./recorder');
const Player = require('./player');
const AI = require('./ai');
const Display = require('./display');
const History = require('./history');
const CommandParser = require('./commands');
const Logger = require('./logger');

class App extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.busy = false;
    this.vadMode = false;
    this._vadAvailable = false;
    this._vadConfig = {};
    this.activeMode = 'pc';
    this.logger = new Logger();

    this.config = {
      audioMode: process.env.AUDIO_MODE || 'timebox',
      idleDisplay: process.env.IDLE_DISPLAY || 'icon',
      wakeWordEnabled: (process.env.WAKE_WORD || 'true') !== 'false',
      vadThreshold: parseInt(process.env.VAD_THRESHOLD) || 500,
      vadSilenceMs: parseInt(process.env.VAD_SILENCE_MS) || 1500,
    };

    this.deviceManager = new DeviceManager();
    this.commandParser = new CommandParser();

    this.recorder = new Recorder({
      device: process.env.MIC_DEVICE || null,
      sampleRate: parseInt(process.env.RECORD_SAMPLE_RATE) || 16000,
      maxSeconds: parseInt(process.env.MAX_RECORD_SECONDS) || 30,
    });

    this.player = new Player();

    this.ai = new AI({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.AI_MODEL || 'mistralai/voxtral-small-24b-2507',
      systemPrompt: process.env.SYSTEM_PROMPT || undefined,
      ttsVoice: process.env.TTS_VOICE || 'ru-RU-DmitryNeural',
    });

    this.display = new Display({
      comPort: process.env.TIMEBOX_COM_PORT || null,
      baudRate: parseInt(process.env.TIMEBOX_BAUD_RATE) || 115200,
      brightness: parseInt(process.env.DISPLAY_BRIGHTNESS) || 80,
    });

    this.history = new History({
      maxMessages: parseInt(process.env.MAX_HISTORY) || 50,
    });

    // Список будильников (3 слота)
    this.alarms = [
      { slot: 0, enabled: false, hour: 0, minute: 0 },
      { slot: 1, enabled: false, hour: 0, minute: 0 },
      { slot: 2, enabled: false, hour: 0, minute: 0 },
    ];

    this.ai.setHistory(this.history);
  }

  _log(msg) {
    this.logger.info(msg);
    this.emit('log', msg);
  }

  _warn(msg) {
    this.logger.warn(msg);
    this.emit('log', `! ${msg}`);
  }

  _error(msg) {
    this.logger.error(msg);
    this.emit('log', `[ERR] ${msg}`);
  }

  async _setState(newState) {
    this.state = newState;
    this.emit('state', newState);
    try {
      const displayState = newState === 'idle' ? 'ready' : newState;
      await this.display.showState(displayState);
    } catch {}
  }

  async _showIdleDisplay() {
    try {
      switch (this.config.idleDisplay) {
        case 'clock': await this.display.showClock(); break;
        case 'vj':    await this.display.showVjEffect(0); break;
        default:      await this.display.showState('ready');
      }
    } catch {}
  }

  // ── Запуск ──

  async start() {
    if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.includes('ВСТАВЬТЕ')) {
      this._error('OPENROUTER_API_KEY не указан. Заполните .env файл.');
      this.emit('error', 'API ключ не настроен');
      return false;
    }

    // Timebox
    const timeboxOk = await this.display.connect();
    this._log(timeboxOk ? 'Timebox Evo: подключён' : 'Timebox Evo: не подключён');

    // Устройства
    const devices = await this.deviceManager.discoverAudioDevices();
    const ports = await this.deviceManager.discoverSerialPorts();

    this._log(`Микрофоны: ${devices.all.length} (HFP: ${devices.hfpMics.length}, PC: ${devices.pcMics.length})`);
    if (ports.length > 0) {
      this._log(`COM-порты: ${ports.map(p => p.path).join(', ')}`);
    }

    // Валидация
    const validation = await this.deviceManager.validateAudioMode(this.config.audioMode);
    this.activeMode = this.config.audioMode;

    if (!validation.valid) {
      validation.warnings.forEach(w => this._warn(w));
      if (validation.fallbackMode) {
        this._warn(`Переключение на режим: ${validation.fallbackMode}`);
        this.activeMode = validation.fallbackMode;
      }
    } else {
      validation.warnings.forEach(w => this._warn(w));
    }

    // Настройка рекордера
    let recDeviceName = process.env.MIC_DEVICE || null;
    let recSampleRate = parseInt(process.env.RECORD_SAMPLE_RATE) || 16000;

    if (!recDeviceName) {
      const recDevice = await this.deviceManager.getRecordingDevice(this.activeMode);
      if (recDevice.name) {
        recDeviceName = recDevice.name;
        recSampleRate = recDevice.sampleRate;
        this.recorder.setDevice(recDeviceName, recSampleRate);
      }
    }

    // VAD (Web Audio в renderer)
    this._setupVAD();

    this._log(`Режим аудио: ${this.activeMode}`);
    this._log(`Модель: ${process.env.AI_MODEL || 'mistralai/voxtral-small-24b-2507'}`);
    this._log(`Wake word: ${this.config.wakeWordEnabled ? 'Джарвис/Колонка/Агент' : 'выключен'}`);
    this._log(`История: ${this.history.length} сообщений`);

    await this._showIdleDisplay();
    this.emit('ready');

    // Автозапуск VAD
    if (this._vadAvailable) {
      this.vadMode = true;
      this._log('[VAD] Автозапуск — слушаю микрофон (Web Audio)...');
      this.emit('vadControl', { action: 'start', config: this._vadConfig });
      this.emit('vadMode', true);
    }

    return true;
  }

  // ── VAD (Web Audio в renderer) ──

  _setupVAD() {
    // VAD теперь работает через Web Audio API в renderer процессе
    // Здесь только сохраняем конфиг и помечаем что VAD доступен
    this._vadAvailable = true;
    this._vadConfig = {
      threshold: this.config.vadThreshold,
      silenceMs: this.config.vadSilenceMs,
      sampleRate: 16000,
    };
  }

  // Вызывается из electron-main.js при получении речи от renderer
  handleVADSpeech(wavBuffer) {
    if (this.busy) return;
    this._log(`[VAD] Фраза записана (${Math.round(wavBuffer.length / 1024)}KB)`);
    this._processAudioBuffer(wavBuffer, true);
  }

  // Вызывается из electron-main.js при начале речи
  handleVADSpeechStart() {
    if (this.busy) return;
    this._log('[VAD] Речь обнаружена...');
    this._setState('listening').catch(() => {});
  }

  toggleVAD() {
    if (!this._vadAvailable) {
      this._warn('VAD недоступен');
      return false;
    }

    this.vadMode = !this.vadMode;

    if (this.vadMode) {
      if (this.state === 'listening') {
        this.recorder.forceStop();
      }
      this._log('[VAD] Включён — слушаю микрофон...');
      this.emit('vadControl', { action: 'start', config: this._vadConfig });
    } else {
      this.emit('vadControl', { action: 'stop' });
      this._log('[VAD] Выключен — PTT');
      this.state = 'idle';
      this.busy = false;
    }

    this.emit('vadMode', this.vadMode);
    return this.vadMode;
  }

  // ── VAD Pause/Resume ──

  _pauseVAD() {
    if (this.vadMode && this._vadAvailable) {
      this.emit('vadControl', { action: 'pause' });
      this._log('[VAD] Пауза (воспроизведение)');
    }
  }

  async _resumeVAD() {
    if (this.vadMode && this._vadAvailable) {
      // Небольшая задержка после воспроизведения
      await new Promise(r => setTimeout(r, 300));
      this.emit('vadControl', { action: 'resume' });
      this._log('[VAD] Возобновлён');
    }
  }

  // ── Push-to-Talk ──

  async startRecording() {
    if (this.vadMode || this.busy || this.state !== 'idle') return;
    this.busy = true;
    try {
      await this._setState('listening');
      this._log('[REC] Запись...');
      await this.recorder.startRecording();
    } catch (err) {
      this._error(`Ошибка записи: ${err.message}`);
      await this._setState('error');
      setTimeout(() => { this._showIdleDisplay(); }, 2000);
      this.busy = false;
    }
  }

  async stopRecording() {
    if (this.state !== 'listening') return;
    try {
      this._log('Остановка записи...');
      const wavBuffer = await this.recorder.stopRecording();
      await this._processAudioBuffer(wavBuffer, false);
    } catch (err) {
      this._error(`Ошибка: ${err.message}`);
      await this._showIdleDisplay();
      this.state = 'idle';
      this.busy = false;
    }
  }

  // ── Текстовый ввод ──

  async sendText(text) {
    if (this.busy) return;
    this.busy = true;

    try {
      await this._setState('processing');
      this._log(`Вы: ${text}`);

      // Команды
      const parsed = this.commandParser.parse(text);
      if (parsed.isCommand) {
        await this._executeCommand(parsed);
        await this._showIdleDisplay();
        this.state = 'idle';
        this.busy = false;
        return;
      }

      this._log('[AI] Думаю...');

      const result = await this.ai.processText(text, {
        onStage: (stage) => {
          const names = { llm: 'Думаю...', tts: 'Озвучивание...' };
          this._log(`[AI] ${names[stage] || stage}`);
        },
      });

      // Ответ AI
      if (result.transcript) {
        this._log(`AI: ${result.transcript}`);
        this.emit('aiText', result.transcript);
      }

      await this._playAIResponse(result);
    } catch (err) {
      this._error(`Ошибка: ${err.message}`);
      await this._setState('error');
      await new Promise(r => setTimeout(r, 2000));
    }

    await this._showIdleDisplay();
    this.state = 'idle';
    this.busy = false;
  }

  // ── Обработка аудио ──

  async _processAudioBuffer(wavBuffer, fromVAD) {
    if (this.state === 'processing' || this.state === 'speaking') return;
    this.busy = true;

    try {
      await this._setState('processing');
      this._log('[AI] Думаю...');

      const result = await this.ai.processAudio(wavBuffer, {
        onTranscript: () => {},
        onUserTranscript: (text) => {
          this._log(`Вы: ${text}`);
          this.emit('userText', text);
        },
        onStage: (stage) => {
          const names = { stt: 'Распознавание...', llm: 'Думаю...', tts: 'Озвучивание...' };
          this._log(`[AI] ${names[stage] || stage}`);
        },
      });

      // Wake word check — только для PTT с wake word, НЕ для VAD
      // В VAD режиме каждая фраза идёт напрямую в AI
      if (!fromVAD && this.config.wakeWordEnabled) {
        const transcript = result.userTranscript || result.transcript || '';
        if (!this.commandParser.containsWakeWord(transcript)) {
          this.busy = false;
          await this._showIdleDisplay();
          this.state = 'idle';
          return;
        }
        this._log('[Wake] Активирован');
      }

      // Команды
      const textToCheck = result.userTranscript || result.transcript || '';
      const parsed = this.commandParser.parse(textToCheck);

      if (parsed.isCommand) {
        await this._executeCommand(parsed);
        await this._showIdleDisplay();
        this.state = 'idle';
        this.busy = false;
        return;
      }

      // Ответ AI
      if (result.transcript) {
        this._log(`AI: ${result.transcript}`);
        this.emit('aiText', result.transcript);
      }

      await this._playAIResponse(result);
    } catch (err) {
      this._error(`Ошибка: ${err.message}`);
      await this._setState('error');
      await new Promise(r => setTimeout(r, 2000));
    }

    await this._showIdleDisplay();
    this.state = 'idle';
    this.busy = false;
  }

  // ── Воспроизведение ответа AI с эмоцией ──

  async _playAIResponse(result) {
    const hasEmotion = result.emotion && result.emotion !== 'neutral';

    if (result.hasAudio && result.audioData.length > 0) {
      await this._setState('speaking');

      // Показать эмоцию ПОВЕРХ speaking-анимации (перезаписывает speaking face)
      if (hasEmotion) {
        this._log(`[EMO] ${result.emotion} (во время воспроизведения)`);
        await this.display.showEmotion(result.emotion, 0);
      }

      this._log('[>>>] Воспроизведение...');
      this._pauseVAD();
      try {
        if (result.audioFormat === 'mp3') {
          await this.player.playMp3(result.audioData);
        } else {
          const sr = parseInt(process.env.PLAYBACK_SAMPLE_RATE) || 24000;
          await this.player.playPcm(result.audioData, sr);
        }
      } finally {
        await this._resumeVAD();
      }
    } else if (hasEmotion) {
      // Нет аудио, но есть эмоция — показать на 3 секунды
      this._log(`[EMO] ${result.emotion}`);
      await this.display.showEmotion(result.emotion, 3000);
    } else if (result.transcript) {
      this._log('(только текст, без аудио)');
    } else {
      this._log('(пустой ответ)');
    }
  }

  async _executeCommand(parsed) {
    this._log(`[CMD] ${parsed.command.description}`);
    switch (parsed.handler) {
      case 'showClock':     await this.display.showClock(); break;
      case 'setBrightness': await this.display.setBrightness(parsed.params.level); break;
      case 'showVjEffect':  await this.display.showVjEffect(parsed.params.effectId); break;
      case 'showText':      await this.display.showText(parsed.params.text); break;
      case 'showEmotion':   await this.display.showEmotion(parsed.params.emotion, 0); break;
      case 'setAlarm':
        const h = Math.min(23, Math.max(0, parsed.params.hour));
        const m = Math.min(59, Math.max(0, parsed.params.minute));
        {
          // Найти свободный слот или использовать первый
          let slot = this.alarms.findIndex(a => !a.enabled);
          if (slot === -1) slot = 0;
          await this.display.setAlarm(slot, h, m);
          await this.display.setVolume(80);
          this.alarms[slot] = { slot, enabled: true, hour: h, minute: m };
          this.emit('alarmsUpdate', this.alarms);
          this._log(`Будильник установлен на ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
          this.emit('aiText', `Будильник установлен на ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
        }
        break;
      case 'clearAlarms':
        await this.display.clearAlarms();
        this.alarms = this.alarms.map((a, i) => ({ slot: i, enabled: false, hour: 0, minute: 0 }));
        this.emit('alarmsUpdate', this.alarms);
        this._log('Все будильники отключены');
        this.emit('aiText', 'Все будильники отключены');
        break;
      case 'setTimer':
        await this.display.startCountdown(parsed.params.minutes, parsed.params.seconds);
        {
          const label = parsed.params.minutes > 0
            ? `${parsed.params.minutes} мин` + (parsed.params.seconds > 0 ? ` ${parsed.params.seconds} сек` : '')
            : `${parsed.params.seconds} сек`;
          this._log(`Таймер установлен на ${label}`);
          this.emit('aiText', `Таймер установлен на ${label}`);
        }
        break;
      case 'stopTimer':
        await this.display.stopCountdown();
        this._log('Таймер остановлен');
        this.emit('aiText', 'Таймер остановлен');
        break;
      case 'setVolume':
        await this.display.setVolume(parsed.params.level);
        this._log(`Громкость: ${parsed.params.level}%`);
        this.emit('aiText', `Громкость: ${parsed.params.level}%`);
        break;
      case 'radioOn':
        await this.display.radioOn(parsed.params.frequency);
        this._log(`Радио включено: ${parsed.params.frequency} FM`);
        this.emit('aiText', `Радио включено: ${parsed.params.frequency} FM`);
        break;
      case 'radioOff':
        await this.display.radioOff();
        this._log('Радио выключено');
        this.emit('aiText', 'Радио выключено');
        break;
      case 'clearHistory':  this.ai.clearHistory(); break;
      case 'stop':          this.player.stop(); await this._showIdleDisplay(); break;
    }
  }

  clearHistory() {
    this.ai.clearHistory();
    this._log('История очищена');
  }

  // ── Будильники (из UI) ──

  async addAlarmFromUI(hour, minute) {
    let slot = this.alarms.findIndex(a => !a.enabled);
    if (slot === -1) slot = 0;
    const h = Math.min(23, Math.max(0, hour));
    const m = Math.min(59, Math.max(0, minute));
    await this.display.setAlarm(slot, h, m);
    await this.display.setVolume(80);
    this.alarms[slot] = { slot, enabled: true, hour: h, minute: m };
    this.emit('alarmsUpdate', this.alarms);
    this._log(`Будильник установлен на ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  }

  async removeAlarmFromUI(slot) {
    if (slot < 0 || slot > 2) return;
    await this.display.clearAlarmSlot(slot);
    this.alarms[slot] = { slot, enabled: false, hour: 0, minute: 0 };
    this.emit('alarmsUpdate', this.alarms);
    this._log(`Будильник #${slot + 1} удалён`);
  }

  // ── Микрофоны ──

  async getMicrophones() {
    const devices = await this.deviceManager.discoverAudioDevices();
    return devices.all.map(name => ({
      name,
      active: name === this.recorder.device,
    }));
  }

  async switchMicrophone(deviceName) {
    if (this.state === 'listening') {
      this.recorder.forceStop();
    }
    // VAD через Web Audio использует системный микрофон по умолчанию
    // При смене микрофона перезапускаем VAD чтобы подхватить новый
    if (this.vadMode && this._vadAvailable) {
      this.emit('vadControl', { action: 'stop' });
      setTimeout(() => {
        this.emit('vadControl', { action: 'start', config: this._vadConfig });
      }, 300);
    }

    this.recorder.setDevice(deviceName, 16000);
    this._log(`Микрофон: ${deviceName}`);
    this.emit('micChanged', deviceName);
  }

  async shutdown() {
    if (this.vadMode && this._vadAvailable) {
      this.emit('vadControl', { action: 'stop' });
    }
    this.recorder.forceStop();
    this.player.cleanup();
    await this.display.disconnect();
    this._log('Завершение работы');
    this.logger.close();
  }
}

module.exports = App;
