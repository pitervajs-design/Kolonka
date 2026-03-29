/**
 * Vosk STT worker — runs in a separate Node.js process
 * to avoid Electron native module ABI mismatch.
 *
 * Communication via IPC:
 *   parent -> worker: { type: 'recognize', id, wavBase64, sampleRate }
 *   worker -> parent: { type: 'result', id, text }
 *   worker -> parent: { type: 'error', id, message }
 *   worker -> parent: { type: 'ready' }
 */
const vosk = require('vosk');
const path = require('path');
const fs = require('fs');

const modelPath = process.env.VOSK_MODEL_PATH ||
  path.join(process.cwd(), 'models', 'vosk-model-small-ru-0.22');

if (!fs.existsSync(modelPath)) {
  process.send({ type: 'error', id: null, message: `Model not found: ${modelPath}` });
  process.exit(1);
}

vosk.setLogLevel(-1);
const model = new vosk.Model(modelPath);
process.send({ type: 'ready' });

process.on('message', (msg) => {
  if (msg.type !== 'recognize') return;

  try {
    const wavBuffer = Buffer.from(msg.wavBase64, 'base64');
    const pcm = wavBuffer.length > 44 ? wavBuffer.slice(44) : wavBuffer;
    const sampleRate = msg.sampleRate || 16000;

    const rec = new vosk.Recognizer({ model, sampleRate });
    const chunkSize = 4000;
    for (let i = 0; i < pcm.length; i += chunkSize) {
      rec.acceptWaveform(pcm.slice(i, Math.min(i + chunkSize, pcm.length)));
    }

    const final = rec.finalResult();
    const result = typeof final === 'string' ? JSON.parse(final) : final;
    rec.free();

    process.send({ type: 'result', id: msg.id, text: (result.text || '').trim() });
  } catch (err) {
    process.send({ type: 'error', id: msg.id, message: err.message });
  }
});

process.on('disconnect', () => {
  model.free();
  process.exit(0);
});
