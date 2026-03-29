const OpenAI = require('openai');
const LocalSTT = require('./stt-local');
const EdgeTTS = require('./tts-edge');

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

    this.model = config.model || 'x-ai/grok-4.1-fast';
    this.systemPrompt = config.systemPrompt ||
      'Ты — умный голосовой помощник встроенный в колонку Divoom Timebox Evo. ' +
      'Отвечай кратко и по делу на русском языке. Ты дружелюбный и полезный.';

    // Локальный STT (Vosk)
    this.localSTT = new LocalSTT({
      sampleRate: config.sttSampleRate || 16000,
      modelPath: config.sttModelPath || undefined,
    });

    // Локальный TTS (Edge TTS)
    this.edgeTTS = new EdgeTTS({
      voice: config.ttsVoice || 'ru-RU-DmitryNeural',
    });

    this.history = null;
  }

  setHistory(history) {
    this.history = history;
  }

  // ── Основной метод: Vosk STT → LLM → Edge TTS ──

  async processAudio(wavBuffer, callbacks = {}) {
    // Этап 1: Локальный STT (Vosk)
    if (callbacks.onStage) callbacks.onStage('stt');
    let userText;
    try {
      userText = await this.localSTT.recognize(wavBuffer);
    } catch (err) {
      userText = '[ошибка распознавания: ' + err.message + ']';
    }
    if (!userText) userText = '[тишина]';
    if (callbacks.onUserTranscript) callbacks.onUserTranscript(userText);

    // Этап 2: LLM (текст → текст)
    if (callbacks.onStage) callbacks.onStage('llm');
    const historyMessages = this.history ? this.history.getApiMessages() : [];

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...historyMessages,
      { role: 'user', content: userText },
    ];

    let responseText = '';
    const stream = await this.client.chat.completions.create({
      model: this.model,
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

    // Этап 3: Локальный TTS (Edge TTS)
    if (callbacks.onStage) callbacks.onStage('tts');
    let audioData = Buffer.alloc(0);
    try {
      audioData = await this.edgeTTS.synthesize(responseText);
    } catch {
      // TTS ошибка — продолжаем с текстом
    }

    // Сохранить в историю
    if (this.history) {
      this.history.addExchange(userText, responseText, { emotion });
    }

    return {
      audioData,
      audioFormat: 'mp3',
      transcript: responseText,
      userTranscript: userText,
      hasAudio: audioData.length > 0,
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
