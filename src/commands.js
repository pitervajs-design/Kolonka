// ═══════════════════════════════════════════
// Голосовые команды для управления Timebox
// Парсинг текста после STT на предмет команд
// ═══════════════════════════════════════════

// JS regex \b не работает с кириллицей — используем паттерны без \b

// ── Русские числительные → число ──
const WORD_NUMS = {
  'ноль': 0, 'нуль': 0,
  'один': 1, 'одна': 1, 'одно': 1, 'раз': 1,
  'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5,
  'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9,
  'десять': 10, 'одиннадцать': 11, 'двенадцать': 12,
  'тринадцать': 13, 'четырнадцать': 14, 'пятнадцать': 15,
  'шестнадцать': 16, 'семнадцать': 17, 'восемнадцать': 18,
  'девятнадцать': 19, 'двадцать': 20, 'тридцать': 30,
  'сорок': 40, 'пятьдесят': 50, 'час': 1,
};

function parseRussianNumber(word) {
  if (!word) return null;
  const w = word.toLowerCase().trim();
  const d = parseInt(w);
  if (!isNaN(d)) return d;
  return WORD_NUMS[w] !== undefined ? WORD_NUMS[w] : null;
}

// Извлечь часы и минуты из текста (цифрами или словами)
function extractTime(text) {
  // Формат с цифрами HH:MM, HH-MM, HH.MM, HH MM
  let m = text.match(/(\d{1,2})[:\-. ](\d{2})/);
  if (m) return { hour: parseInt(m[1]), minute: parseInt(m[2]) };

  // "час тридцать", "два тридцать", "три сорок пять"
  const wordPattern = /(час|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+(ноль\s*)?(\d{1,2}|двадцать|тридцать|сорок|пятьдесят|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|ноль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять)/i;
  m = text.match(wordPattern);
  if (m) {
    const hour = parseRussianNumber(m[1]);
    let minute = parseRussianNumber(m[3]);
    if (hour !== null && minute !== null) return { hour, minute };
  }

  // Только число/слово часа: "будильник на 7", "будильник на два"
  m = text.match(/(\d{1,2})\s*(часов|час|утра|вечера|ночи|дня)?/);
  if (m) return { hour: parseInt(m[1]), minute: 0 };

  // Слово часа без минут: "на два", "на семь"
  const hourWords = text.match(/(час|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s*(часов|час|утра|вечера|ночи|дня)?$/i);
  if (hourWords) {
    const h = parseRussianNumber(hourWords[1]);
    if (h !== null) return { hour: h, minute: 0 };
  }

  return { hour: 7, minute: 0 };
}

// Wake word паттерны
const WAKE_PATTERNS = [
  /джарвис/i,
  /жарвис/i,
  /д[жш]арвис/i,
  /\bjarvis\b/i,
  /колонка/i,
  /калонка/i,
  /агент/i,
  /\bagent\b/i,
];

// Определения команд
const COMMANDS = [
  {
    name: 'time',
    description: 'Показать часы',
    patterns: [
      /(покажи|включи|поставь)\s*(часы|время)/i,
      /сколько\s*времени/i,
      /который\s*час/i,
    ],
    handler: 'showClock',
    extract: () => ({}),
  },
  {
    name: 'brightness',
    description: 'Яркость дисплея',
    patterns: [
      /яркость\s*(\d+)/i,
      /(установи|поставь|сделай)\s*яркость\s*(\d+)/i,
      /яркость\s*(на|в)\s*(\d+)/i,
      /\bbrightness\s*(\d+)/i,
    ],
    handler: 'setBrightness',
    extract: (text) => {
      const m = text.match(/(\d+)/);
      return { level: m ? Math.min(100, Math.max(0, parseInt(m[1]))) : 50 };
    },
  },
  {
    name: 'effect',
    description: 'VJ-эффект',
    patterns: [
      /(эффект|визуал|анимаци[яю])\s*(\d+)?/i,
      /(покажи|включи|поставь)\s*(эффект|визуал)\s*(\d+)?/i,
      /\b(effect|vj)\s*(\d+)?/i,
    ],
    handler: 'showVjEffect',
    extract: (text) => {
      const m = text.match(/\d+/);
      return { effectId: m ? Math.min(15, Math.max(0, parseInt(m[0]))) : 0 };
    },
  },
  {
    name: 'stop',
    description: 'Остановить/выключить',
    patterns: [
      /(^|\s)(стоп|остановись|замолчи|тихо|хватит|выключись)(\s|$|[.,!?])/i,
      /\bstop\b/i,
    ],
    handler: 'stop',
    extract: () => ({}),
  },
  {
    name: 'set_alarm',
    description: 'Установить будильник',
    patterns: [
      /(поставь|установи|включи|заведи|сделай|создай)\s*(будильник|alarm)\s*(на|в|к)?\s*(\d{1,2})[:\-. ](\d{2})/i,
      /(будильник|alarm)\s*(на|в|к)?\s*(\d{1,2})[:\-. ](\d{2})/i,
      /(поставь|установи|включи|заведи)\s*(будильник|alarm)\s*(на|в|к)?\s*(\d{1,2})\s*(часов|час|утра|вечера|ночи|дня)?/i,
      /(поставь|установи|включи|заведи|сделай|создай)\s*(будильник|alarm)\s*(на|в|к)?\s*(час|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)/i,
    ],
    handler: 'setAlarm',
    extract: (text) => extractTime(text),
  },
  {
    name: 'clear_alarm',
    description: 'Отключить все будильники',
    patterns: [
      /(отключи|выключи|убери|удали|сбрось|отмени)\s*(все\s*)?(будильник|alarm)/i,
      /(будильник|alarm)\s*(отключи|выключи|убери|удали|отмени)/i,
    ],
    handler: 'clearAlarms',
    extract: () => ({}),
  },
  {
    name: 'clear_history',
    description: 'Очистить историю разговора',
    patterns: [
      /(очисти|сбрось|удали|забудь)\s*(историю|память|разговор|чат)/i,
      /\bclear\s*history\b/i,
    ],
    handler: 'clearHistory',
    extract: () => ({}),
  },
  {
    name: 'set_timer',
    description: 'Запустить таймер',
    patterns: [
      /(поставь|установи|включи|запусти|заведи)\s*(таймер|отсч[её]т|countdown)\s*(на)?\s*(\d+)\s*(мин|минут|секунд|сек)/i,
      /(таймер|отсч[её]т)\s*(на)?\s*(\d+)\s*(мин|минут|секунд|сек)/i,
    ],
    handler: 'setTimer',
    extract: (text) => {
      const m = text.match(/(\d+)\s*(мин|минут|секунд|сек)/i);
      if (m) {
        const val = parseInt(m[1]);
        const isSec = /сек/i.test(m[2]);
        return isSec ? { minutes: 0, seconds: val } : { minutes: val, seconds: 0 };
      }
      return { minutes: 5, seconds: 0 };
    },
  },
  {
    name: 'stop_timer',
    description: 'Остановить таймер',
    patterns: [
      /(останови|выключи|отключи|сбрось|отмени)\s*(таймер|отсч[её]т|countdown)/i,
    ],
    handler: 'stopTimer',
    extract: () => ({}),
  },
  {
    name: 'set_volume',
    description: 'Установить громкость',
    patterns: [
      /громкость\s*(\d+)/i,
      /(установи|поставь|сделай)\s*громкость\s*(на\s*)?(\d+)/i,
      /(сделай|поставь)\s*(потише|тише|громче)/i,
    ],
    handler: 'setVolume',
    extract: (text) => {
      const m = text.match(/(\d+)/);
      if (m) return { level: Math.min(100, Math.max(0, parseInt(m[1]))) };
      if (/тише|потише/i.test(text)) return { level: 30, delta: -20 };
      if (/громче/i.test(text)) return { level: 70, delta: 20 };
      return { level: 50 };
    },
  },
  {
    name: 'radio_on',
    description: 'Включить радио',
    patterns: [
      /(включи|запусти|поставь)\s*(радио|fm)\s*(\d+[\.,]\d+)?/i,
      /(радио|fm)\s*(\d+[\.,]\d+)/i,
    ],
    handler: 'radioOn',
    extract: (text) => {
      const m = text.match(/(\d+[\.,]\d+)/);
      if (m) return { frequency: parseFloat(m[1].replace(',', '.')) };
      return { frequency: 100.0 };
    },
  },
  {
    name: 'radio_off',
    description: 'Выключить радио',
    patterns: [
      /(выключи|отключи|останови|убери)\s*(радио|fm)/i,
    ],
    handler: 'radioOff',
    extract: () => ({}),
  },
  {
    name: 'emotion',
    description: 'Показать эмоцию на дисплее',
    patterns: [
      /(сделай|покажи|поставь)\s*(сердит|злое?|злую|злой|angry)\s*(лицо|рожиц[уа]|морд[уа]|физиономи[юя])?/i,
      /(сделай|покажи|поставь)\s*(грустн|печальн|sad)\s*(лицо|рожиц[уа]|морд[уа]|физиономи[юя])?/i,
      /(сделай|покажи|поставь)\s*(весёл|радостн|счастлив|happy)\s*(лицо|рожиц[уа]|морд[уа]|физиономи[юя])?/i,
    ],
    handler: 'showEmotion',
    extract: (text) => {
      if (/сердит|злое?|злую|злой|angry/i.test(text)) return { emotion: 'angry' };
      if (/грустн|печальн|sad/i.test(text)) return { emotion: 'sad' };
      if (/весёл|радостн|счастлив|happy/i.test(text)) return { emotion: 'happy' };
      return { emotion: 'angry' };
    },
  },
  {
    name: 'text',
    description: 'Показать текст на дисплее',
    patterns: [
      /(покажи|выведи|напиши|отобрази)\s*(текст|надпись|слово|сообщение)\s+(.+)/i,
      /(покажи|напиши)\s+на\s*(экране|дисплее)\s+(.+)/i,
    ],
    handler: 'showText',
    extract: (text) => {
      const m = text.match(/(?:покажи|выведи|напиши|отобрази)\s*(?:текст|надпись|слово|сообщение|на\s*(?:экране|дисплее))?\s+(.+)/i);
      return { text: m ? m[1].trim() : text };
    },
  },
];

class CommandParser {
  constructor() {
    this.commands = COMMANDS;
    this.wakePatterns = WAKE_PATTERNS;
  }

  // Проверить содержит ли текст wake word
  containsWakeWord(text) {
    if (!text) return false;
    return this.wakePatterns.some(p => p.test(text));
  }

  // Убрать wake word из текста, вернуть остаток
  stripWakeWord(text) {
    if (!text) return '';
    let result = text;
    for (const p of this.wakePatterns) {
      result = result.replace(p, '').trim();
    }
    // Убрать начальные запятые, точки
    return result.replace(/^[,.\s!]+/, '').trim();
  }

  // Распарсить текст на команду
  // Возвращает { isCommand, command, params } или { isCommand: false }
  parse(text) {
    if (!text) return { isCommand: false };

    // Убираем wake word если есть
    const cleanText = this.stripWakeWord(text);

    for (const cmd of this.commands) {
      for (const pattern of cmd.patterns) {
        if (pattern.test(cleanText)) {
          return {
            isCommand: true,
            command: cmd,
            handler: cmd.handler,
            params: cmd.extract(cleanText),
            originalText: text,
            cleanText,
          };
        }
      }
    }

    return { isCommand: false, cleanText, originalText: text };
  }

  // Получить справку по командам
  getHelpText() {
    return this.commands.map(c => `  ${c.name}: ${c.description}`).join('\n');
  }
}

module.exports = CommandParser;
