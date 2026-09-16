/**
 * Подготовка встроенного распознавателя речи: сборка whisper.cpp и модель.
 *
 * Результат кладётся в `desktop/resources/whisper` — оттуда его забирает
 * установщик (`extraResources` в `electron-builder.yml`), не заворачивая
 * в архив приложения: исполняемый файл из архива не запустить, а модель весом
 * в сотню мегабайт незачем читать через виртуальную файловую систему.
 *
 * Собирается из исходников, а не берётся готовым: официальные сборки есть не
 * для всех платформ, а собрать одинаково на macOS и Windows проще, чем
 * поддерживать два разных способа установки. Версия закреплена: распознаватель
 * не должен молча меняться посреди работы.
 *
 * Требуются `git` и `cmake`. На CI они есть на образах macOS и Windows,
 * локально на macOS — `brew install cmake`.
 *
 * Запуск: `npm run whisper -w @lt/desktop`
 *   --force       собрать заново, даже если файлы уже на месте
 *   --model=NAME  другая модель (по умолчанию ggml-base.bin)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesDir = join(desktopDir, 'resources', 'whisper');
const modelsDir = join(resourcesDir, 'models');
const cacheDir = join(desktopDir, '.cache');
const sourceDir = join(cacheDir, 'whisper.cpp');

/** Закреплённая версия whisper.cpp. Поднимать — сознательно и с проверкой. */
const WHISPER_TAG = 'v1.9.4';

/** Репозиторий whisper.cpp. */
const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp.git';

/** Откуда берутся файлы моделей. */
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Модель по умолчанию: многоязычная `base` (~148 МБ).
 *
 * Компромисс размера установщика и качества: `tiny` заметно чаще ошибается на
 * неродной речи — а это ровно те, кто учит язык, — `small` весит 488 МБ.
 * Модель побольше пользователь может положить в свой каталог моделей и
 * указать её в настройках.
 */
const DEFAULT_MODEL = 'ggml-base.bin';

/** Минимальный правдоподобный размер файла модели, байты. */
const MIN_MODEL_BYTES = 10 * 1024 * 1024;

const args = process.argv.slice(2);
const force = args.includes('--force');
const modelName =
  args.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) ?? DEFAULT_MODEL;

/** Имя исполняемого файла распознавателя на текущей платформе. */
const binaryName = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';

/** Запускает команду, показывая её вывод. */
function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit' });
}

/** Клонирует нужную версию исходников; повторный запуск переиспользует кэш. */
function fetchSources() {
  if (existsSync(join(sourceDir, 'CMakeLists.txt'))) {
    console.log(`Исходники whisper.cpp уже есть: ${sourceDir}`);

    return;
  }

  mkdirSync(cacheDir, { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG, WHISPER_REPO, sourceDir]);
}

/**
 * Собирает `whisper-server` статически: одна программа без библиотек рядом.
 * Так её проще подписать и невозможно оставить без зависимости при копировании.
 */
function buildServer() {
  const buildDir = join(sourceDir, 'build');

  run(
    'cmake',
    [
      '-B',
      buildDir,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      '-DWHISPER_BUILD_SERVER=ON',
      // Шейдеры Metal — внутрь программы: искать их рядом с исполняемым файлом
      // внутри пакета приложения она не должна.
      '-DGGML_METAL_EMBED_LIBRARY=ON',
    ],
    sourceDir,
  );
  run(
    'cmake',
    ['--build', buildDir, '--config', 'Release', '--target', 'whisper-server', '-j', '4'],
    sourceDir,
  );

  // Многоконфигурационные генераторы (MSVC) кладут результат в подкаталог конфигурации.
  const candidates = [
    join(buildDir, 'bin', binaryName),
    join(buildDir, 'bin', 'Release', binaryName),
  ];
  const built = candidates.find((candidate) => existsSync(candidate));

  if (built === undefined) {
    throw new Error(`Сборка не оставила исполняемого файла: ${candidates.join(', ')}`);
  }

  mkdirSync(resourcesDir, { recursive: true });
  copyFileSync(built, join(resourcesDir, binaryName));
  console.log(`Распознаватель: ${join(resourcesDir, binaryName)}`);
}

/** Скачивает файл модели, если его ещё нет. */
async function fetchModel() {
  const target = join(modelsDir, modelName);

  if (!force && existsSync(target) && statSync(target).size > MIN_MODEL_BYTES) {
    console.log(`Модель уже на месте: ${target}`);

    return;
  }

  mkdirSync(modelsDir, { recursive: true });

  const url = `${MODEL_BASE_URL}/${modelName}`;

  console.log(`Скачиваем модель ${modelName}…`);

  const response = await fetch(url, { redirect: 'follow' });

  if (!response.ok || response.body === null) {
    throw new Error(`Не удалось скачать ${url}: HTTP ${response.status}`);
  }

  // Через временный файл: прерванная загрузка не должна оставить огрызок,
  // который при запуске выглядит как испорченная модель.
  const temporary = `${target}.part`;
  const { writeFile } = await import('node:fs/promises');

  await writeFile(temporary, response.body);

  const { renameSync } = await import('node:fs');

  renameSync(temporary, target);
  console.log(`Модель: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(0)} МБ)`);
}

async function main() {
  if (force) {
    rmSync(join(resourcesDir, binaryName), { force: true });
  }

  if (force || !existsSync(join(resourcesDir, binaryName))) {
    fetchSources();
    buildServer();
  } else {
    console.log(`Распознаватель уже собран: ${join(resourcesDir, binaryName)}`);
  }

  await fetchModel();
}

await main();
