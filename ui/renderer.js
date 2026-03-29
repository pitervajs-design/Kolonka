const { ipcRenderer } = require('electron');

const chat = document.getElementById('chat');
const stateIcon = document.getElementById('stateIcon');
const stateLabel = document.getElementById('stateLabel');
const btnPtt = document.getElementById('btnPtt');
const btnVad = document.getElementById('btnVad');
const btnClear = document.getElementById('btnClear');
const modeLabel = document.getElementById('modeLabel');
const statusInfo = document.getElementById('statusInfo');
const micSelect = document.getElementById('micSelect');

let isRecording = false;
let vadActive = false;

const STATE_LABELS = {
  idle: 'Готов',
  listening: 'Слушаю...',
  processing: 'Думаю...',
  speaking: 'Говорю...',
  error: 'Ошибка',
};

// ── Сообщения в чат ──

function addMsg(text, type = 'log') {
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;
  div.textContent = text;
  chat.appendChild(div);
  // Лимит 200 сообщений
  while (chat.children.length > 200) chat.removeChild(chat.firstChild);
  chat.scrollTop = chat.scrollHeight;
}

// ── IPC события из main ──

ipcRenderer.on('log', (_, msg) => {
  addMsg(msg, 'log');
  statusInfo.textContent = msg.substring(0, 60);
});

ipcRenderer.on('state', (_, state) => {
  stateIcon.className = `header-icon ${state}`;
  stateLabel.textContent = STATE_LABELS[state] || state;

  if (state === 'listening') {
    btnPtt.classList.add('active');
  } else {
    btnPtt.classList.remove('active');
    isRecording = false;
    btnPtt.querySelector('.btn-label').textContent = 'Запись';
  }
});

ipcRenderer.on('vadMode', (_, enabled) => {
  vadActive = enabled;
  btnVad.classList.toggle('active', enabled);
  modeLabel.textContent = enabled ? 'VAD' : 'PTT';
});

ipcRenderer.on('userText', (_, text) => {
  addMsg(text, 'user');
});

ipcRenderer.on('aiText', (_, text) => {
  addMsg(text, 'ai');
});

ipcRenderer.on('ready', () => {
  addMsg('Kolonka AI готова к работе', 'system');
  loadMicrophones();
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

// ── Кнопки ──

btnPtt.addEventListener('click', () => {
  if (vadActive) return;
  if (!isRecording) {
    isRecording = true;
    btnPtt.querySelector('.btn-label').textContent = 'Стоп';
    btnPtt.classList.add('active');
    ipcRenderer.send('ptt-start');
  } else {
    isRecording = false;
    btnPtt.querySelector('.btn-label').textContent = 'Запись';
    btnPtt.classList.remove('active');
    ipcRenderer.send('ptt-stop');
  }
});

btnVad.addEventListener('click', () => {
  ipcRenderer.send('toggle-vad');
});

btnClear.addEventListener('click', () => {
  ipcRenderer.send('clear-history');
  // Очищаем user/ai сообщения, оставляем системные
  const msgs = chat.querySelectorAll('.chat-msg.user, .chat-msg.ai');
  msgs.forEach(m => m.remove());
  addMsg('История очищена', 'system');
});

// ── Горячие клавиши ──

document.addEventListener('keydown', (e) => {
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
