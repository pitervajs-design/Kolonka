const OpenAI = require('openai');
const LocalSTT = require('./stt-local');
const EdgeTTS = require('./tts-edge');

// Простое определение эмоций по ключевым словам в ответе AI
const EMOTION_PATTERNS = {
  happy:   /\b(рад|здорово|отлично|замечательно|прекрасно|ура|хорошо|весело|смеш|happy|great|awesome)\b/i,
  sad:     /\b(грустн|печаль|жаль|увы|к сожалению|обидно|плохо|sad|sorry|unfortunately)\b/i,
  excited: /\b(wow|вау|ого|невероятно|потрясающ|удивительн|amazing|incredible|exciting)\b/i,
  angry:   /\b(злость|раздраж|ужасн|безобраз|возмутительн|angry|terrible|awful)\b/i,
};

function detectEmotion(text) {
  if (!text) return 'neutral';
  for (const [emotion, pattern] of Object.entries(EMOTION_PATTERNS)) {
    if (pattern.test(text)) return emotion;
  }
  return 'neutral';
}

class AI {
  constructor(config) {
    this.client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://kolonka-ai.local',
        'X-Title': 'Kolonka AI',
      },
    });

    this.model = config.model || 'openai/gpt-4o-audio-preview';
    this.voice = config.voice || 'nova';
    this.playbackSampleRate = config.playbackSampleRate || 24000;
    this.systemPrompt = config.systemPrompt ||
      'Ты — умный голосовой помощник встроенный в колонку Divoom Timebox Evo. ' +
      'Отвечай кратко и по делу на русском языке. Ты дружелюбный и полезный.';

    // AI_MODE: 'audio' (всё-в-одном) или 'pipeline' (STT→LLM→TTS)
    this.aiMode = config.aiMode || 'audio';

    // Для pipeline-режима
    this.sttModel = config.sttModel || 'openai/whisper-1';
    this.ttsModel = config.ttsModel || 'openai/tts-1';
    this.llmModel = config.llmModel || 'openai/gpt-4o';

    // Локальный STT (Vosk)
    this.useLocalSTT = config.useLocalSTT || false;
    this.localSTT = null;
    if (this.useLocalSTT) {
      this.localSTT = new LocalSTT({
        sampleRate: config.localSTTSampleRate || 16000,
        modelPath: config.localSTTModelPath || undefined,
      });
    }

    // Локальный TTS (Edge TTS)
    this.edgeTTS = new EdgeTTS({
      voice: config.ttsVoice || 'ru-RU-DmitryNeural',
    });

    // История теперь передаётся снаружи
    this.history = null;
  }

  setHistory(history) {
    this.history = history;
  }

  // Основной метод: аудио → аудио (всё-в-одном, gpt-4o-audio-preview)
  async processAudio(wavBuffer, callbacks = {}) {
    if (this.aiMode === 'pipeline') {
      return this._processPipeline(wavBuffer, callbacks);
    }
    return this._processAudioDirect(wavBuffer, callbacks);
  }

  // ═══ Режим 1: всё-в-одном (audio-in, audio-out) ═══

  async _processAudioDirect(wavBuffer, callbacks = {}) {
    const base64Audio = wavBuffer.toString('base64');

    const historyMessages = this.history ? this.history.getApiMessages() : [];

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...historyMessages,
      {
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: { data: base64Audio, format: 'wav' },
        }],
      },
    ];

    const audioParts = [];
    let transcript = '';

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        modalities: ['text', 'audio'],
        audio: { voice: this.voice, format: 'pcm16' },
        messages,
        stream: true,
      });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (!delta) continue;

        if (delta.audio?.data) {
          audioParts.push(Buffer.from(delta.audio.data, 'base64'));
        }

        if (delta.audio?.transcript) {
          transcript += delta.audio.transcript;
          if (callbacks.onTranscript) callbacks.onTranscript(delta.audio.transcript);
        }

        if (delta.content) {
          transcript += delta.content;
          if (callbacks.onTranscript) callbacks.onTranscript(delta.content);
        }
      }

      const audioData = Buffer.concat(audioParts);
      const emotion = detectEmotion(transcript);

      // Сохранить в историю
      if (this.history) {
        this.history.addExchange('[аудио-сообщение]', transcript, { emotion });
      }

      return {
        audioData,
        transcript,
        hasAudio: audioData.length > 0,
        emotion,
      };
    } catch (error) {
      // Fallback на текстовый режим
      if (error.message?.includes('modalities') || error.message?.includes('audio')) {
        return this._textFallback(wavBuffer, callbacks);
      }
      throw error;
    }
  }

  // ═══ Режим 2: Pipeline (STT → LLM → TTS) ═══

  async _processPipeline(wavBuffer, callbacks = {}) {
    // Этап 1: STT
    if (callbacks.onStage) callbacks.onStage('stt');
    const userText = await this._stt(wavBuffer);
    if (callbacks.onUserTranscript) callbacks.onUserTranscript(userText);

    // Этап 2: LLM
    if (callbacks.onStage) callbacks.onStage('llm');
    const historyMessages = this.history ? this.history.getApiMessages() : [];

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...historyMessages,
      { role: 'user', content: userText },
    ];

    let responseText = '';
    const stream = await this.client.chat.completions.create({
      model: this.llmModel,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        responseText += delta.content;
        if (callbacks.onTranscript) callbacks.onTranscript(delta.content);
      }
    }

    const emotion = detectEmotion(responseText);

    // Этап 3: TTS
    if (callbacks.onStage) callbacks.onStage('tts');
    let audioData = Buffer.alloc(0);
    let audioFormat = 'pcm';
    try {
      const ttsResult = await this._tts(responseText);
      audioData = ttsResult.data;
      audioFormat = ttsResult.format;
    } catch (err) {
      // TTS может не поддерживаться — продолжаем с текстом
    }

    // Сохранить в историю
    if (this.history) {
      this.history.addExchange(userText, responseText, { emotion });
    }

    return {
      audioData,
      audioFormat,
      transcript: responseText,
      userTranscript: userText,
      hasAudio: audioData.length > 0,
      emotion,
    };
  }

  // STT — локальный (Vosk) или облачный
  async _stt(wavBuffer) {
    if (this.localSTT) {
      try {
        const text = await this.localSTT.recognize(wavBuffer);
        return text || '[тишина]';
      } catch (err) {
        return '[ошибка локального распознавания: ' + err.message + ']';
      }
    }

    // Fallback: облачный STT через audio-capable модель
    try {
      // OpenRouter может не поддерживать Whisper напрямую
      // Используем audio-capable модель для распознавания
      const base64Audio = wavBuffer.toString('base64');
      const response = await this.client.chat.completions.create({
        model: this.model, // audio-capable model
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Распознай и перепиши дословно что сказано в этом аудио. Ответь ТОЛЬКО текстом распознанной речи, без комментариев.' },
            { type: 'input_audio', input_audio: { data: base64Audio, format: 'wav' } },
          ],
        }],
      });
      return response.choices?.[0]?.message?.content || '[не удалось распознать]';
    } catch {
      return '[ошибка распознавания]';
    }
  }

  // TTS — Edge TTS (MP3)
  async _tts(text) {
    try {
      const mp3Buffer = await this.edgeTTS.synthesize(text);
      return { data: mp3Buffer, format: 'mp3' };
    } catch {
      return { data: Buffer.alloc(0), format: 'mp3' };
    }
  }

  // Текстовый fallback
  async _textFallback(wavBuffer, callbacks = {}) {
    const base64Audio = wavBuffer.toString('base64');
    const historyMessages = this.history ? this.history.getApiMessages() : [];

    const messages = [
      {
        role: 'system',
        content: this.systemPrompt +
          '\nВАЖНО: Пользователь отправляет голосовое сообщение. Сначала распознай что он сказал, затем ответь.',
      },
      ...historyMessages,
      {
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: { data: base64Audio, format: 'wav' },
        }],
      },
    ];

    let textResponse = '';
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        textResponse += delta.content;
        if (callbacks.onTranscript) callbacks.onTranscript(delta.content);
      }
    }

    const emotion = detectEmotion(textResponse);

    if (this.history) {
      this.history.addExchange('[аудио-сообщение]', textResponse, { emotion });
    }

    return {
      audioData: Buffer.alloc(0),
      transcript: textResponse,
      hasAudio: false,
      emotion,
    };
  }

  clearHistory() {
    if (this.history) {
      this.history.clear();
    }
  }
}

module.exports = AI;
