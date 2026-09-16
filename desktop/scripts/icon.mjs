/**
 * Рисует иконку приложения в `build-assets/icon.png` (1024×1024).
 *
 * Иконка считается кодом, а не лежит картинкой в репозитории: так её можно
 * поправить без графического редактора, а в истории видно, что именно
 * изменилось. Установщик сам переводит PNG в форматы платформ (`.icns`, `.ico`).
 *
 * Рисование идёт функциями расстояния до фигуры: для каждой точки известно,
 * насколько она внутри фигуры, и край сглаживается по ширине пикселя — без
 * этого на диагоналях «лесенка».
 *
 * Запуск: `node scripts/icon.mjs`
 */
import { crc32, deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outFile = join(dirname(dirname(fileURLToPath(import.meta.url))), 'build-assets', 'icon.png');

/** Сторона иконки в пикселях: этого хватает и macOS, и Windows. */
const SIZE = 1024;

/** Цвет фона сверху и снизу: мягкий переход синего в фиолетовый. */
const TOP_COLOR = [79, 70, 229];
const BOTTOM_COLOR = [124, 58, 237];

/** Цвет облачка реплики. */
const BUBBLE_COLOR = [255, 255, 255];

/** Расстояние до прямоугольника со скруглёнными углами (в долях стороны). */
function roundedRect(x, y, centerX, centerY, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x - centerX) - (halfWidth - radius);
  const dy = Math.abs(y - centerY) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));

  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Расстояние до отрезка со скруглёнными концами — из таких сложена буква. */
function stroke(x, y, fromX, fromY, toX, toY, radius) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const lengthSquared = dx * dx + dy * dy;
  // Проекция точки на отрезок, ограниченная его концами.
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - fromX) * dx + (y - fromY) * dy) / lengthSquared));

  return Math.hypot(x - (fromX + dx * t), y - (fromY + dy * t)) - radius;
}

/** Та же фигура, повёрнутая на 45°: из неё получается хвостик облачка. */
function diamond(x, y, centerX, centerY, half, radius) {
  const dx = x - centerX;
  const dy = y - centerY;
  const rotatedX = (dx + dy) * Math.SQRT1_2;
  const rotatedY = (dy - dx) * Math.SQRT1_2;

  return roundedRect(rotatedX, rotatedY, 0, 0, half, half, radius);
}

/** Доля пикселя, попавшая внутрь фигуры: 0 — снаружи, 1 — целиком внутри. */
function coverage(distance, pixel) {
  return Math.min(1, Math.max(0, 0.5 - distance / pixel));
}

/** Кладёт цвет поверх уже нарисованного с учётом прозрачности. */
function blend(target, offset, color, alpha) {
  for (let channel = 0; channel < 3; channel += 1) {
    target[offset + channel] = Math.round(
      (color[channel] ?? 0) * alpha + (target[offset + channel] ?? 0) * (1 - alpha),
    );
  }

  target[offset + 3] = Math.round(255 * alpha + (target[offset + 3] ?? 0) * (1 - alpha));
}

/** Собирает пиксели иконки. */
function drawIcon() {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const pixel = 1 / SIZE;

  for (let row = 0; row < SIZE; row += 1) {
    const y = (row + 0.5) / SIZE;

    for (let column = 0; column < SIZE; column += 1) {
      const x = (column + 0.5) / SIZE;
      const offset = (row * SIZE + column) * 4;

      // Подложка: скруглённый квадрат во весь холст.
      const background = coverage(roundedRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22), pixel);

      if (background <= 0) {
        continue;
      }

      const gradient = TOP_COLOR.map((channel, index) =>
        Math.round(channel + ((BOTTOM_COLOR[index] ?? 0) - channel) * y),
      );

      blend(pixels, offset, gradient, background);

      // Облачко реплики с хвостиком влево-вниз.
      const body = roundedRect(x, y, 0.5, 0.455, 0.28, 0.185, 0.085);
      const tail = diamond(x, y, 0.375, 0.625, 0.055, 0.02);
      const bubble = coverage(Math.min(body, tail), pixel);

      blend(pixels, offset, BUBBLE_COLOR, bubble * background);

      // Буква «A» в облачке: язык, который произносят вслух. Три отрезка со
      // скруглёнными концами — две наклонные и перекладина.
      const letter = Math.min(
        stroke(x, y, 0.437, 0.545, 0.5, 0.355, 0.026),
        stroke(x, y, 0.563, 0.545, 0.5, 0.355, 0.026),
        stroke(x, y, 0.458, 0.487, 0.542, 0.487, 0.022),
      );

      blend(pixels, offset, gradient, coverage(letter, pixel) * bubble);
    }
  }

  return pixels;
}

/** Собирает часть файла PNG вместе с контрольной суммой. */
function chunk(type, data) {
  const length = Buffer.alloc(4);

  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);

  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

/** Кодирует пиксели в PNG без потерь. */
function encodePng(pixels) {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  // 8 бит на канал, цвет с прозрачностью, без чересстрочности.
  header[8] = 8;
  header[9] = 6;

  // Каждая строка изображения предваряется байтом способа предсказания; нулевой
  // способ означает «как есть»: сжатие берёт своё, а код остаётся понятным.
  const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));

  for (let row = 0; row < SIZE; row += 1) {
    const from = row * SIZE * 4;
    const to = (row + 1) * SIZE * 4;

    rows[row * (SIZE * 4 + 1)] = 0;
    Buffer.from(pixels.subarray(from, to)).copy(rows, row * (SIZE * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(outFile, encodePng(drawIcon()));
console.log(`Иконка: ${outFile}`);
