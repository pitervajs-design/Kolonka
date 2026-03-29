const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

class EdgeTTS {
  constructor(config = {}) {
    this.voice = config.voice || 'ru-RU-DmitryNeural';
    this.format = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;
    this.tts = null;
  }

  async init() {
    if (this.tts) return;
    this.tts = new MsEdgeTTS();
    await this.tts.setMetadata(this.voice, this.format);
  }

  /**
   * Generate speech audio from text.
   * @param {string} text
   * @returns {Promise<Buffer>} MP3 audio buffer
   */
  async synthesize(text) {
    await this.init();

    const result = await this.tts.toStream(text);
    const chunks = [];

    return new Promise((resolve, reject) => {
      result.audioStream.on('data', (chunk) => chunks.push(chunk));
      result.audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      result.audioStream.on('error', reject);
    });
  }
}

module.exports = EdgeTTS;
