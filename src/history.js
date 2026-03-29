const fs = require('fs');
const path = require('path');

class History {
  constructor(config = {}) {
    this.maxMessages = config.maxMessages || 50;
    this.filePath = config.filePath || path.join(process.cwd(), 'data', 'history.json');
    this.messages = [];
    this.sessionId = Date.now().toString(36);
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.messages = Array.isArray(data.messages) ? data.messages : [];
        // Обрезаем при загрузке
        if (this.messages.length > this.maxMessages) {
          this.messages = this.messages.slice(-this.maxMessages);
        }
      }
    } catch {
      this.messages = [];
    }
  }

  _save() {
    try {
      const data = {
        sessionId: this.sessionId,
        updatedAt: new Date().toISOString(),
        messageCount: this.messages.length,
        messages: this.messages,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      // Тихая ошибка — история не критична
    }
  }

  // Добавить пару сообщений (user + assistant)
  addExchange(userText, assistantText, metadata = {}) {
    const timestamp = new Date().toISOString();

    this.messages.push({
      role: 'user',
      content: userText || '[аудио-сообщение]',
      timestamp,
      session: this.sessionId,
    });

    this.messages.push({
      role: 'assistant',
      content: assistantText || '[аудио-ответ]',
      timestamp,
      session: this.sessionId,
      ...(metadata.emotion ? { emotion: metadata.emotion } : {}),
    });

    // Обрезаем
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    this._save();
  }

  // Получить историю в формате для API (без метаданных)
  getApiMessages() {
    return this.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  // Очистить историю
  clear() {
    this.messages = [];
    this.sessionId = Date.now().toString(36);
    this._save();
  }

  get length() {
    return this.messages.length;
  }
}

module.exports = History;
