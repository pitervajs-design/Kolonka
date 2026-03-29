// ═══════════════════════════════════════════
// Голосовые команды для управления Timebox
// Парсинг текста после STT на предмет команд
// ═══════════════════════════════════════════

// JS regex \b не работает с кириллицей — используем паттерны без \b

// Wake word паттерны
const WAKE_PATTERNS = [
  /джарвис/i,
  /жарвис/i,
  /д[жш]арвис/i,
  /\bjarvis\b/i,
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
