require('dotenv').config();
const EventEmitter = require('events');
const DeviceManager = require('./devices');
const Recorder = require('./recorder');
const Player = require('./player');
const AI = require('./ai');
const Display = require('./display');
const History = require('./history');
const VAD = require('./vad');
const CommandParser = require('./commands');
const Logger = require('./logger');

class App extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.busy = false;
    this.vadMode = false;
    this.vad = null;
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
      model: process.env.AI_MODEL || 'google/gemini-2.0-flash-lite-001',
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

    // VAD
    if (recDeviceName) {
      this._setupVAD(recDeviceName, recSampleRate);
    }

    this._log(`Режим аудио: ${this.activeMode}`);
    this._log(`Модель: ${process.env.AI_MODEL || 'google/gemini-2.0-flash-lite-001'}`);
    this._log(`Wake word: ${this.config.wakeWordEnabled ? 'Джарвис' : 'выключен'}`);
    this._log(`История: ${this.history.length} сообщений`);

    await this._showIdleDisplay();
    this.emit('ready');
    return true;
  }

  // ── VAD ──

  _setupVAD(deviceName, sampleRate) {
    this.vad = new VAD({
      device: deviceName,
      sampleRate: sampleRate || 16000,
      threshold: this.config.vadThreshold,
      silenceMs: this.config.vadSilenceMs,
    });

    this.vad.on('speechStart', () => {
      if (this.busy) return;
      this._log('[VAD] Речь обнаружена...');
      this._setState('listening').catch(() => {});
    });

    this.vad.on('speech', async (wavBuffer) => {
      if (this.busy) return;
      this._log('[VAD] Фраза записана');
      await this._processAudioBuffer(wavBuffer, true);
    });

    this.vad.on('error', (err) => {
      this._error(`[VAD] Ошибка: ${err.message}`);
    });
  }

  toggleVAD() {
    if (!this.vad) {
      this._warn('VAD недоступен — микрофон не настроен');
      return false;
    }

    this.vadMode = !this.vadMode;

    if (this.vadMode) {
      if (this.state === 'listening') {
        this.recorder.forceStop();
      }
      this._log('[VAD] Включён' + (this.config.wakeWordEnabled ? ' (скажите "Джарвис")' : ''));
      this.vad.start().catch(err => {
        this._error(`[VAD] Ошибка: ${err.message}`);
        this.vadMode = false;
      });
    } else {
      this.vad.stop();
      this._log('[VAD] Выключен — PTT');
      this.state = 'idle';
      this.busy = false;
    }

    this.emit('vadMode', this.vadMode);
    return this.vadMode;
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

      // Wake word check для VAD
      if (fromVAD && this.config.wakeWordEnabled) {
        const transcript = result.transcript || result.userTranscript || '';
        if (!this.commandParser.containsWakeWord(transcript)) {
          this.busy = false;
          await this._showIdleDisplay();
          this.state = 'idle';
          return;
        }
        this._log('[Джарвис] Активирован');
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

      if (result.emotion && result.emotion !== 'neutral') {
        this.display.showEmotion(result.emotion, 2000).catch(() => {});
      }

      if (result.hasAudio && result.audioData.length > 0) {
        await this._setState('speaking');
        this._log('[>>>] Воспроизведение...');
        if (result.audioFormat === 'mp3') {
          await this.player.playMp3(result.audioData);
        } else {
          const sr = parseInt(process.env.PLAYBACK_SAMPLE_RATE) || 24000;
          await this.player.playPcm(result.audioData, sr);
        }
      } else if (result.transcript) {
        this._log('(только текст, без аудио)');
      } else {
        this._log('(пустой ответ)');
      }
    } catch (err) {
      this._error(`Ошибка: ${err.message}`);
      await this._setState('error');
      await new Promise(r => setTimeout(r, 2000));
    }

    await this._showIdleDisplay();
    this.state = 'idle';
    this.busy = false;
  }

  async _executeCommand(parsed) {
    this._log(`[CMD] ${parsed.command.description}`);
    switch (parsed.handler) {
      case 'showClock':     await this.display.showClock(); break;
      case 'setBrightness': await this.display.setBrightness(parsed.params.level); break;
      case 'showVjEffect':  await this.display.showVjEffect(parsed.params.effectId); break;
      case 'showText':      await this.display.showText(parsed.params.text); break;
      case 'clearHistory':  this.ai.clearHistory(); break;
      case 'stop':          this.player.stop(); await this._showIdleDisplay(); break;
    }
  }

  clearHistory() {
    this.ai.clearHistory();
    this._log('История очищена');
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
    if (this.vadMode && this.vad) {
      this.vad.stop();
      this.vadMode = false;
      this.emit('vadMode', false);
    }

    this.recorder.setDevice(deviceName, 16000);
    this._setupVAD(deviceName, 16000);
    this._log(`Микрофон: ${deviceName}`);
    this.emit('micChanged', deviceName);
  }

  async shutdown() {
    if (this.vad) this.vad.stop();
    this.recorder.forceStop();
    this.player.cleanup();
    await this.display.disconnect();
    this._log('Завершение работы');
    this.logger.close();
  }
}

module.exports = App;
