const { ipcRenderer } = require('electron');

const chat = document.getElementById('chat');
const stateLabel = document.getElementById('stateLabel');
const btnPtt = document.getElementById('btnPtt');
const btnVad = document.getElementById('btnVad');
const btnClear = document.getElementById('btnClear');
const modeLabel = document.getElementById('modeLabel');
const statusInfo = document.getElementById('statusInfo');
const micSelect = document.getElementById('micSelect');
const versionLabel = document.getElementById('versionLabel');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const vadLabel = document.getElementById('vadLabel');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');

// Показать версию из package.json
try {
  const pkg = require('../package.json');
  versionLabel.textContent = `v${pkg.version}`;
} catch {}

let isRecording = false;
let vadActive = false;

const STATE_LABELS = {
  idle: '',
  listening: 'Слушаю...',
  processing: 'Думаю...',
  speaking: 'Говорю...',
  error: 'Ошибка',
};

const STATE_STATUS = {
  idle: { text: 'ОНЛАЙН', dot: 'online' },
  listening: { text: 'СЛУШАЮ', dot: 'listening' },
  processing: { text: 'ДУМАЮ', dot: 'processing' },
  speaking: { text: 'ГОВОРЮ', dot: 'speaking' },
  error: { text: 'ОШИБКА', dot: '' },
};

// ── Навигация сайдбара ──

const allPages = document.querySelectorAll('.page-panel');

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    // Показать нужную панель, скрыть остальные
    allPages.forEach(p => {
      p.style.display = p.id === `page-${page}` ? 'flex' : 'none';
    });
  });
});

// ── Сообщения в чат ──

function getTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

function addMsg(text, type = 'log') {
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;

  if (type === 'user' || type === 'ai') {
    const txt = document.createElement('div');
    txt.textContent = text;
    div.appendChild(txt);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = getTime();
    div.appendChild(time);
  } else {
    div.textContent = text;
  }

  chat.appendChild(div);
  while (chat.children.length > 200) chat.removeChild(chat.firstChild);
  chat.scrollTop = chat.scrollHeight;
}

// ── IPC события из main ──

ipcRenderer.on('log', (_, msg) => {
  addMsg(msg, 'log');
  statusInfo.textContent = msg.substring(0, 80);
});

ipcRenderer.on('state', (_, state) => {
  stateLabel.textContent = STATE_LABELS[state] || state;

  const ss = STATE_STATUS[state] || STATE_STATUS.idle;
  statusDot.className = `status-dot ${ss.dot}`;
  statusText.textContent = ss.text;

  if (state === 'listening') {
    textInput.placeholder = 'Слушаю...';
    btnPtt.classList.add('active');
  } else if (state === 'processing') {
    textInput.placeholder = 'Думаю...';
    btnPtt.classList.remove('active');
    isRecording = false;
  } else if (state === 'speaking') {
    textInput.placeholder = 'Говорю...';
  } else {
    textInput.placeholder = 'Напишите сообщение...';
    btnPtt.classList.remove('active');
    isRecording = false;
  }
});

ipcRenderer.on('vadMode', (_, enabled) => {
  vadActive = enabled;
  modeLabel.textContent = enabled ? 'VAD' : 'PTT';
  vadLabel.textContent = enabled ? 'VAD: ВКЛ' : 'VAD: ВЫКЛ';
  btnVad.classList.toggle('active', enabled);
});

ipcRenderer.on('userText', (_, text) => {
  addMsg(text, 'user');
});

ipcRenderer.on('aiText', (_, text) => {
  addMsg(text, 'ai');
});

ipcRenderer.on('ready', () => {
  addMsg('Kolonka AI готова к работе', 'system');
  statusDot.className = 'status-dot online';
  statusText.textContent = 'ОНЛАЙН';
  loadMicrophones();
  loadAlarms();
});

// ── Микрофоны ──

async function loadMicrophones() {
  const mics = await ipcRenderer.invoke('get-mics');
  micSelect.innerHTML = '';
  mics.forEach(mic => {
    const opt = document.createElement('option');
    opt.value = mic.name;
    opt.textContent = mic.name;
    if (mic.active) opt.selected = true;
    micSelect.appendChild(opt);
  });
}

micSelect.addEventListener('change', () => {
  ipcRenderer.send('switch-mic', micSelect.value);
});

ipcRenderer.on('micChanged', (_, name) => {
  micSelect.value = name;
});

// ── Будильники ──

const alarmsList = document.getElementById('alarmsList');
const alarmsEmpty = document.getElementById('alarmsEmpty');
const alarmHour = document.getElementById('alarmHour');
const alarmMinute = document.getElementById('alarmMinute');
const btnAddAlarm = document.getElementById('btnAddAlarm');

async function loadAlarms() {
  const alarms = await ipcRenderer.invoke('get-alarms');
  renderAlarms(alarms);
}

function renderAlarms(alarms) {
  // Удалить старые карточки (оставить alarmsEmpty)
  alarmsList.querySelectorAll('.alarm-card').forEach(c => c.remove());

  const active = alarms.filter(a => a.enabled);

  if (active.length === 0) {
    alarmsEmpty.style.display = 'block';
    return;
  }

  alarmsEmpty.style.display = 'none';

  for (const alarm of active) {
    const card = document.createElement('div');
    card.className = 'alarm-card';

    const timeStr = String(alarm.hour).padStart(2, '0') + ':' + String(alarm.minute).padStart(2, '0');

    card.innerHTML =
      '<div class="alarm-card-left">' +
        '<span class="alarm-card-icon">&#9200;</span>' +
        '<div>' +
          '<div class="alarm-card-time">' + timeStr + '</div>' +
          '<div class="alarm-card-slot">СЛОТ #' + (alarm.slot + 1) + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="mc-btn alarm-del-btn" data-slot="' + alarm.slot + '" title="Удалить">X</button>';

    card.querySelector('.alarm-del-btn').addEventListener('click', () => {
      ipcRenderer.send('remove-alarm', alarm.slot);
    });

    alarmsList.appendChild(card);
  }
}

ipcRenderer.on('alarmsUpdate', (_, alarms) => {
  renderAlarms(alarms);
});

btnAddAlarm.addEventListener('click', () => {
  const hour = parseInt(alarmHour.value) || 0;
  const minute = parseInt(alarmMinute.value) || 0;
  ipcRenderer.send('add-alarm', { hour, minute });
});

// Enter в полях ввода будильника
alarmHour.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') btnAddAlarm.click();
});
alarmMinute.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') btnAddAlarm.click();
});

// ── Кнопки ──

btnPtt.addEventListener('click', () => {
  if (vadActive) return;
  if (!isRecording) {
    isRecording = true;
    btnPtt.classList.add('active');
    ipcRenderer.send('ptt-start');
  } else {
    isRecording = false;
    btnPtt.classList.remove('active');
    ipcRenderer.send('ptt-stop');
  }
});

// Кнопка ОТПРАВИТЬ — отправляет текст или работает как PTT
sendBtn.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (text) {
    sendTextMessage(text);
  } else {
    btnPtt.click();
  }
});

// Отправка текста по Enter
textInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && !e.repeat) {
    e.preventDefault();
    const text = textInput.value.trim();
    if (text) {
      sendTextMessage(text);
    }
  }
});

function sendTextMessage(text) {
  addMsg(text, 'user');
  textInput.value = '';
  ipcRenderer.send('send-text', text);
}

btnVad.addEventListener('click', () => {
  ipcRenderer.send('toggle-vad');
});

btnClear.addEventListener('click', () => {
  ipcRenderer.send('clear-history');
  const msgs = chat.querySelectorAll('.chat-msg.user, .chat-msg.ai');
  msgs.forEach(m => m.remove());
  addMsg('История очищена', 'system');
});

// ── Кнопки окна ──

document.querySelector('.win-min')?.addEventListener('click', () => {
  ipcRenderer.send('win-minimize');
});

document.querySelector('.win-max')?.addEventListener('click', () => {
  ipcRenderer.send('win-maximize');
});

document.querySelector('.win-close')?.addEventListener('click', () => {
  ipcRenderer.send('quit');
});

// ── Web Audio VAD ──

const WebVAD = require('./vad-web');
let webVad = null;

ipcRenderer.on('vad-control', (_, data) => {
  const { action, config } = data;
  switch (action) {
    case 'start':  startWebVAD(config); break;
    case 'stop':   stopWebVAD(); break;
    case 'pause':  pauseWebVAD(); break;
    case 'resume': resumeWebVAD(); break;
  }
});

async function startWebVAD(config = {}) {
  if (webVad && webVad.isActive) return;

  if (!webVad) {
    webVad = new WebVAD({
      threshold: config.threshold || 200,
      silenceMs: config.silenceMs || 1500,
    });

    webVad.onSpeechStart = () => {
      ipcRenderer.send('vad-speech-start');
    };

    webVad.onSpeech = (wavData) => {
      // wavData — Uint8Array, конвертируем в Buffer для IPC
      ipcRenderer.send('vad-speech', Buffer.from(wavData.buffer, wavData.byteOffset, wavData.byteLength));
    };

    webVad.onDebug = (msg) => {
      ipcRenderer.send('vad-debug', msg);
    };

    webVad.onError = (err) => {
      ipcRenderer.send('vad-error', err.message);
    };
  }

  try {
    await webVad.start();
  } catch (err) {
    ipcRenderer.send('vad-error', err.message);
  }
}

function stopWebVAD() {
  if (webVad) {
    webVad.stop();
    webVad = null; // пересоздадим при следующем старте с актуальными настройками
  }
}

async function pauseWebVAD() {
  if (webVad && webVad.isActive) {
    await webVad.pause();
  }
}

async function resumeWebVAD() {
  if (webVad && webVad.isActive) {
    await webVad.resume();
  }
}

// ── Горячие клавиши ──

document.addEventListener('keydown', (e) => {
  // Не перехватывать клавиши если фокус в текстовом поле
  if (document.activeElement === textInput) return;

  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    btnPtt.click();
  }
  if (e.code === 'KeyV' && !e.repeat) {
    btnVad.click();
  }
  if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey) {
    btnClear.click();
  }
});
