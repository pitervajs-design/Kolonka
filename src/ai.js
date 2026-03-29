const OpenAI = require('openai');
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

    this.model = config.model || 'google/gemini-2.0-flash-lite-001';
    this.systemPrompt = config.systemPrompt ||
      'Ты — умный голосовой помощник встроенный в колонку Divoom Timebox Evo. ' +
      'Отвечай кратко и по делу на русском языке. Ты дружелюбный и полезный.';

    // Локальный TTS (Edge TTS)
    this.edgeTTS = new EdgeTTS({
      voice: config.ttsVoice || 'ru-RU-DmitryNeural',
    });

    this.history = null;
  }

  setHistory(history) {
    this.history = history;
  }

  // ── Основной метод: аудио → Gemini (STT+LLM) → текст → Edge TTS ──

  async processAudio(wavBuffer, callbacks = {}) {
    const base64Audio = wavBuffer.toString('base64');
    const historyMessages = this.history ? this.history.getApiMessages() : [];

    // Этап 1: Отправляем аудио в Gemini (STT + LLM в одном вызове)
    if (callbacks.onStage) callbacks.onStage('llm');

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...historyMessages,
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: base64Audio, format: 'wav' },
          },
        ],
      },
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

    if (callbacks.onUserTranscript) {
      callbacks.onUserTranscript('[аудио]');
    }

    const emotion = detectEmotion(responseText);

    // Этап 2: Озвучиваем ответ через Edge TTS (локально)
    if (callbacks.onStage) callbacks.onStage('tts');
    let audioData = Buffer.alloc(0);
    try {
      audioData = await this.edgeTTS.synthesize(responseText);
    } catch {
      // TTS ошибка — продолжаем с текстом
    }

    // Сохранить в историю
    if (this.history) {
      this.history.addExchange('[аудио-сообщение]', responseText, { emotion });
    }

    return {
      audioData,
      audioFormat: 'mp3',
      transcript: responseText,
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
