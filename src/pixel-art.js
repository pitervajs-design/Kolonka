// ═══════════════════════════════════════════
// Пиксельная графика 16x16 для Timebox Evo
// Анимированное лицо AI-ассистента
// ═══════════════════════════════════════════

const COLORS = {
  black:      [0, 0, 0],
  white:      [255, 255, 255],
  green:      [0, 200, 0],
  greenBright:[0, 255, 0],
  greenDim:   [0, 100, 0],
  red:        [255, 50, 50],
  redBright:  [255, 0, 0],
  redDim:     [150, 0, 0],
  yellow:     [255, 200, 0],
  yellowDim:  [150, 120, 0],
  blue:       [0, 100, 255],
  blueBright: [50, 150, 255],
  blueDim:    [0, 50, 150],
  cyan:       [0, 200, 200],
  cyanBright: [0, 255, 255],
  cyanDim:    [0, 120, 120],
  purple:     [150, 50, 255],
  orange:     [255, 130, 0],
  pink:       [255, 100, 150],
  gray:       [80, 80, 80],
  grayLight:  [150, 150, 150],
};

// ── Утилиты ──

function emptyGrid() {
  return new Array(256).fill(0);
}

function setPixel(grid, x, y, colorIdx) {
  if (x >= 0 && x < 16 && y >= 0 && y < 16) {
    grid[y * 16 + Math.floor(x)] = colorIdx;
  }
}

function drawCircle(grid, cx, cy, r, colorIdx, filled = true) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (filled ? dist <= r : (dist >= r - 0.6 && dist <= r + 0.6)) {
        setPixel(grid, x, y, colorIdx);
      }
    }
  }
}

function drawRect(grid, x1, y1, x2, y2, colorIdx) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      setPixel(grid, x, y, colorIdx);
    }
  }
}

function drawLine(grid, x1, y1, x2, y2, colorIdx) {
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  let x = x1, y = y1;
  while (true) {
    setPixel(grid, x, y, colorIdx);
    if (x === x2 && y === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// ═══════════════════════════════════════════
// ЛИЦО AI — базовые элементы
// ═══════════════════════════════════════════

// Глаза: 2 пикселя в высоту, цвет 1 = основной, цвет 2 = яркий/зрачок
// Позиции глаз: левый (4-5, y), правый (10-11, y)
const EYE_L = 4, EYE_R = 10, EYE_Y = 5;

function drawFaceOutline(grid, colorIdx) {
  // Скруглённый квадрат — контур лица
  // Верх
  for (let x = 3; x <= 12; x++) setPixel(grid, x, 1, colorIdx);
  // Низ
  for (let x = 3; x <= 12; x++) setPixel(grid, x, 14, colorIdx);
  // Бока
  for (let y = 2; y <= 13; y++) {
    setPixel(grid, 2, y, colorIdx);
    setPixel(grid, 13, y, colorIdx);
  }
  // Углы скруглённые
  setPixel(grid, 2, 1, 0); setPixel(grid, 13, 1, 0);
  setPixel(grid, 2, 14, 0); setPixel(grid, 13, 14, 0);
}

function drawEyesOpen(grid, c1, c2) {
  // Левый глаз — 2x2 с зрачком
  setPixel(grid, EYE_L, EYE_Y, c1);
  setPixel(grid, EYE_L + 1, EYE_Y, c2);
  setPixel(grid, EYE_L, EYE_Y + 1, c2);
  setPixel(grid, EYE_L + 1, EYE_Y + 1, c1);
  // Правый глаз
  setPixel(grid, EYE_R, EYE_Y, c2);
  setPixel(grid, EYE_R + 1, EYE_Y, c1);
  setPixel(grid, EYE_R, EYE_Y + 1, c1);
  setPixel(grid, EYE_R + 1, EYE_Y + 1, c2);
}

function drawEyesClosed(grid, c1) {
  // Закрытые — горизонтальная линия
  setPixel(grid, EYE_L, EYE_Y + 1, c1);
  setPixel(grid, EYE_L + 1, EYE_Y + 1, c1);
  setPixel(grid, EYE_R, EYE_Y + 1, c1);
  setPixel(grid, EYE_R + 1, EYE_Y + 1, c1);
}

function drawEyesWide(grid, c1, c2) {
  // Широко открытые — 2x3
  for (let dy = 0; dy <= 2; dy++) {
    setPixel(grid, EYE_L, EYE_Y - 1 + dy, c1);
    setPixel(grid, EYE_L + 1, EYE_Y - 1 + dy, c1);
    setPixel(grid, EYE_R, EYE_Y - 1 + dy, c1);
    setPixel(grid, EYE_R + 1, EYE_Y - 1 + dy, c1);
  }
  // Зрачки
  setPixel(grid, EYE_L, EYE_Y, c2);
  setPixel(grid, EYE_L + 1, EYE_Y, c2);
  setPixel(grid, EYE_R, EYE_Y, c2);
  setPixel(grid, EYE_R + 1, EYE_Y, c2);
}

function drawEyesHalf(grid, c1) {
  // Полуприкрытые — 2x1
  setPixel(grid, EYE_L, EYE_Y + 1, c1);
  setPixel(grid, EYE_L + 1, EYE_Y + 1, c1);
  setPixel(grid, EYE_R, EYE_Y + 1, c1);
  setPixel(grid, EYE_R + 1, EYE_Y + 1, c1);
  // Верхнее веко
  setPixel(grid, EYE_L, EYE_Y, c1);
  setPixel(grid, EYE_R + 1, EYE_Y, c1);
}

function drawEyesLookLeft(grid, c1, c2) {
  // Глаза смотрят влево
  setPixel(grid, EYE_L, EYE_Y, c2);
  setPixel(grid, EYE_L, EYE_Y + 1, c1);
  setPixel(grid, EYE_L + 1, EYE_Y, c1);
  setPixel(grid, EYE_L + 1, EYE_Y + 1, c1);
  setPixel(grid, EYE_R, EYE_Y, c2);
  setPixel(grid, EYE_R, EYE_Y + 1, c1);
  setPixel(grid, EYE_R + 1, EYE_Y, c1);
  setPixel(grid, EYE_R + 1, EYE_Y + 1, c1);
}

function drawEyesLookRight(grid, c1, c2) {
  setPixel(grid, EYE_L, EYE_Y, c1);
  setPixel(grid, EYE_L, EYE_Y + 1, c1);
  setPixel(grid, EYE_L + 1, EYE_Y, c1);
  setPixel(grid, EYE_L + 1, EYE_Y + 1, c2);
  setPixel(grid, EYE_R, EYE_Y, c1);
  setPixel(grid, EYE_R, EYE_Y + 1, c1);
  setPixel(grid, EYE_R + 1, EYE_Y, c1);
  setPixel(grid, EYE_R + 1, EYE_Y + 1, c2);
}

// Рот
function drawSmile(grid, c1) {
  // Улыбка — дуга вниз
  setPixel(grid, 5, 10, c1);
  setPixel(grid, 6, 11, c1);
  setPixel(grid, 7, 11, c1);
  setPixel(grid, 8, 11, c1);
  setPixel(grid, 9, 11, c1);
  setPixel(grid, 10, 10, c1);
}

function drawSmileSmall(grid, c1) {
  setPixel(grid, 6, 10, c1);
  setPixel(grid, 7, 11, c1);
  setPixel(grid, 8, 11, c1);
  setPixel(grid, 9, 10, c1);
}

function drawMouthOpen(grid, c1, c2) {
  // Открытый рот — овал
  setPixel(grid, 6, 10, c1);
  setPixel(grid, 7, 10, c1);
  setPixel(grid, 8, 10, c1);
  setPixel(grid, 9, 10, c1);
  setPixel(grid, 6, 11, c1);
  setPixel(grid, 7, 11, c2);
  setPixel(grid, 8, 11, c2);
  setPixel(grid, 9, 11, c1);
  setPixel(grid, 6, 12, c1);
  setPixel(grid, 7, 12, c1);
  setPixel(grid, 8, 12, c1);
  setPixel(grid, 9, 12, c1);
}

function drawMouthWide(grid, c1, c2) {
  // Широко открытый рот
  setPixel(grid, 5, 10, c1);
  for (let x = 6; x <= 9; x++) setPixel(grid, x, 10, c1);
  setPixel(grid, 10, 10, c1);
  setPixel(grid, 5, 11, c1);
  for (let x = 6; x <= 9; x++) setPixel(grid, x, 11, c2);
  setPixel(grid, 10, 11, c1);
  setPixel(grid, 5, 12, c1);
  for (let x = 6; x <= 9; x++) setPixel(grid, x, 12, c2);
  setPixel(grid, 10, 12, c1);
  for (let x = 5; x <= 10; x++) setPixel(grid, x, 13, c1);
}

function drawMouthLine(grid, c1) {
  // Прямая линия
  for (let x = 6; x <= 9; x++) setPixel(grid, x, 11, c1);
}

function drawMouthSmallOpen(grid, c1) {
  setPixel(grid, 7, 10, c1);
  setPixel(grid, 8, 10, c1);
  setPixel(grid, 7, 11, c1);
  setPixel(grid, 8, 11, c1);
}

function drawMouthSad(grid, c1) {
  setPixel(grid, 5, 12, c1);
  setPixel(grid, 6, 11, c1);
  setPixel(grid, 7, 11, c1);
  setPixel(grid, 8, 11, c1);
  setPixel(grid, 9, 11, c1);
  setPixel(grid, 10, 12, c1);
}

// ═══════════════════════════════════════════
// Статические иконки (лица)
// ═══════════════════════════════════════════

// 0=чёрный, 1=контур/основной, 2=зрачок/акцент, 3=рот внутри

function iconReady() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesOpen(grid, 1, 2);
  drawSmile(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.cyan, COLORS.cyanBright] };
}

function iconListening() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesWide(grid, 1, 2);
  drawMouthSmallOpen(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.cyan, COLORS.cyanBright] };
}

function iconThinking() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesHalf(grid, 1);
  drawMouthLine(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.yellow] };
}

function iconSpeaking() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesOpen(grid, 1, 2);
  drawMouthOpen(grid, 1, 0);
  return { pixels: grid, colors: [COLORS.black, COLORS.cyan, COLORS.cyanBright] };
}

function iconError() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  // X-глаза
  setPixel(grid, EYE_L, EYE_Y, 1); setPixel(grid, EYE_L + 1, EYE_Y + 1, 1);
  setPixel(grid, EYE_L + 1, EYE_Y, 1); setPixel(grid, EYE_L, EYE_Y + 1, 1);
  setPixel(grid, EYE_R, EYE_Y, 1); setPixel(grid, EYE_R + 1, EYE_Y + 1, 1);
  setPixel(grid, EYE_R + 1, EYE_Y, 1); setPixel(grid, EYE_R, EYE_Y + 1, 1);
  drawMouthSad(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.redBright] };
}

// ═══════════════════════════════════════════
// Анимации лица
// ═══════════════════════════════════════════

// Ready — спокойное лицо с морганием
function* readyFrames() {
  let tick = 0;
  while (true) {
    const grid = emptyGrid();
    drawFaceOutline(grid, 1);

    // Моргание каждые ~40 кадров (4 сек при 10fps)
    const blinkPhase = tick % 40;
    if (blinkPhase === 0 || blinkPhase === 1) {
      drawEyesClosed(grid, 1);
    } else {
      drawEyesOpen(grid, 1, 2);
    }

    drawSmile(grid, 1);
    yield { pixels: grid, colors: [COLORS.black, COLORS.cyan, COLORS.cyanBright] };
    tick++;
  }
}

// Listening — широкие глаза, пульсирующий контур
function* listeningFrames() {
  let tick = 0;
  while (true) {
    const grid = emptyGrid();

    // Пульсирующий контур — чередуем цвет
    const pulse = Math.sin(tick * 0.3) > 0;
    drawFaceOutline(grid, pulse ? 1 : 2);
    drawEyesWide(grid, 1, 2);
    drawMouthSmallOpen(grid, 1);

    // Звуковые волны по бокам
    const wavePhase = tick % 6;
    if (wavePhase < 3) {
      setPixel(grid, 0, 7, 2);
      setPixel(grid, 15, 7, 2);
    }
    if (wavePhase < 2) {
      setPixel(grid, 1, 6, 2);
      setPixel(grid, 1, 8, 2);
      setPixel(grid, 14, 6, 2);
      setPixel(grid, 14, 8, 2);
    }

    yield { pixels: grid, colors: [COLORS.black, COLORS.cyan, COLORS.cyanBright] };
    tick++;
  }
}

// Thinking — глаза бегают влево-вправо, точки под ртом
function* thinkingFrames() {
  let tick = 0;
  const lookSequence = ['left', 'center', 'right', 'center', 'up', 'center'];
  while (true) {
    const grid = emptyGrid();
    drawFaceOutline(grid, 1);

    const lookIdx = Math.floor(tick / 5) % lookSequence.length;
    const look = lookSequence[lookIdx];

    switch (look) {
      case 'left':
        drawEyesLookLeft(grid, 1, 2);
        break;
      case 'right':
        drawEyesLookRight(grid, 1, 2);
        break;
      case 'up':
        drawEyesHalf(grid, 1);
        break;
      default:
        drawEyesOpen(grid, 1, 2);
    }

    drawMouthLine(grid, 1);

    // Анимированные точки «...» под лицом
    const dots = (tick % 12);
    if (dots >= 0) setPixel(grid, 5, 15, 1);
    if (dots >= 4) setPixel(grid, 7, 15, 1);
    if (dots >= 8) setPixel(grid, 9, 15, 1);

    yield { pixels: grid, colors: [COLORS.black, COLORS.yellow, COLORS.yellowDim] };
    tick++;
  }
}

// Speaking — рот открывается/закрывается, звуковые волны
function* speakingFrames() {
  let tick = 0;
  while (true) {
    const grid = emptyGrid();
    drawFaceOutline(grid, 1);
    drawEyesOpen(grid, 1, 2);

    // Рот пульсирует: закрыт → маленький → большой → маленький
    const mouthPhase = tick % 8;
    if (mouthPhase < 1) {
      drawSmileSmall(grid, 1);
    } else if (mouthPhase < 3) {
      drawMouthSmallOpen(grid, 1);
    } else if (mouthPhase < 5) {
      drawMouthOpen(grid, 1, 3);
    } else if (mouthPhase < 7) {
      drawMouthWide(grid, 1, 3);
    } else {
      drawMouthOpen(grid, 1, 3);
    }

    // Звуковые волны справа
    const wave = tick % 4;
    if (wave < 2) {
      setPixel(grid, 14, 7, 2);
      setPixel(grid, 15, 6, 2);
      setPixel(grid, 15, 8, 2);
    }
    if (wave < 1) {
      setPixel(grid, 15, 7, 2);
    }

    yield { pixels: grid, colors: [COLORS.black, COLORS.cyan, COLORS.cyanBright, COLORS.cyanDim] };
    tick++;
  }
}

// Error — мигающее лицо с X-глазами
function* errorFrames() {
  let tick = 0;
  while (true) {
    const grid = emptyGrid();
    if (tick % 4 < 3) {
      drawFaceOutline(grid, 1);
      // X-глаза
      setPixel(grid, EYE_L, EYE_Y, 1); setPixel(grid, EYE_L + 1, EYE_Y + 1, 1);
      setPixel(grid, EYE_L + 1, EYE_Y, 1); setPixel(grid, EYE_L, EYE_Y + 1, 1);
      setPixel(grid, EYE_R, EYE_Y, 1); setPixel(grid, EYE_R + 1, EYE_Y + 1, 1);
      setPixel(grid, EYE_R + 1, EYE_Y, 1); setPixel(grid, EYE_R, EYE_Y + 1, 1);
      drawMouthSad(grid, 1);
    }
    yield { pixels: grid, colors: [COLORS.black, COLORS.redBright] };
    tick++;
  }
}

// ═══════════════════════════════════════════
// Эмоции (лица)
// ═══════════════════════════════════════════

function emotionHappy() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  // Глаза-дуги (счастливые, прищуренные)
  setPixel(grid, EYE_L, EYE_Y, 1); setPixel(grid, EYE_L + 1, EYE_Y - 1, 1);
  setPixel(grid, EYE_R + 1, EYE_Y, 1); setPixel(grid, EYE_R, EYE_Y - 1, 1);
  drawSmile(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.yellow] };
}

function emotionSad() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesOpen(grid, 1, 1);
  drawMouthSad(grid, 1);
  // Слеза
  setPixel(grid, EYE_L + 1, EYE_Y + 2, 2);
  return { pixels: grid, colors: [COLORS.black, COLORS.blue, COLORS.blueBright] };
}

function emotionNeutral() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesOpen(grid, 1, 1);
  drawMouthLine(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.grayLight] };
}

function emotionExcited() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  drawEyesWide(grid, 1, 2);
  drawMouthWide(grid, 1, 0);
  // Искры вокруг
  setPixel(grid, 0, 0, 2); setPixel(grid, 15, 0, 2);
  setPixel(grid, 0, 15, 2); setPixel(grid, 15, 15, 2);
  return { pixels: grid, colors: [COLORS.black, COLORS.orange, COLORS.yellow] };
}

function emotionAngry() {
  const grid = emptyGrid();
  drawFaceOutline(grid, 1);
  // Сердитые брови
  drawLine(grid, EYE_L - 1, EYE_Y - 2, EYE_L + 2, EYE_Y - 1, 1);
  drawLine(grid, EYE_R + 2, EYE_Y - 2, EYE_R - 1, EYE_Y - 1, 1);
  drawEyesOpen(grid, 1, 1);
  drawMouthSad(grid, 1);
  return { pixels: grid, colors: [COLORS.black, COLORS.redBright] };
}

// ═══════════════════════════════════════════
// Экспорт
// ═══════════════════════════════════════════

module.exports = {
  COLORS,
  emptyGrid,
  setPixel,
  drawCircle,
  drawRect,
  drawLine,
  icons: {
    ready: iconReady,
    listening: iconListening,
    thinking: iconThinking,
    speaking: iconSpeaking,
    error: iconError,
  },
  animations: {
    ready: readyFrames,
    listening: listeningFrames,
    thinking: thinkingFrames,
    speaking: speakingFrames,
    error: errorFrames,
  },
  emotions: {
    happy: emotionHappy,
    sad: emotionSad,
    neutral: emotionNeutral,
    excited: emotionExcited,
    angry: emotionAngry,
  },
};
