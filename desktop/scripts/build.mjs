/**
 * Сборка десктопной оболочки: всё, что попадёт в установщик, складывается
 * в `desktop/build/app`.
 *
 * Сервер собирается в один файл. Иначе в установщик пришлось бы класть
 * `node_modules` монорепозитория вместе с симлинками рабочих пространств
 * (`@lt/shared`, `@lt/server`), а их каждая платформа разворачивает по-своему.
 * Снаружи бандла остаётся только `better-sqlite3`: это нативный модуль,
 * собрать его в JavaScript нельзя.
 *
 * Файлы миграций копируются рядом с бандлом: `tsc` их не переносит, а раннер
 * ищет каталог `migrations` рядом со своим модулем — в собранном виде это
 * как раз каталог приложения.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoDir = dirname(desktopDir);
const outDir = join(desktopDir, 'build', 'app');

/** Версия Node внутри Electron: под неё собирается и оболочка, и сервер. */
const NODE_TARGET = 'node22';

/**
 * Рабочие пространства, которые попадают в установщик собранными.
 *
 * Порядок важен: сервер и интерфейс собираются против типов `@lt/shared`.
 */
const WORKSPACES = [
  {
    name: '@lt/shared',
    sourceDir: join(repoDir, 'shared', 'src'),
    artifact: join(repoDir, 'shared', 'dist', 'index.js'),
  },
  {
    name: '@lt/server',
    sourceDir: join(repoDir, 'server', 'src'),
    artifact: join(repoDir, 'server', 'dist', 'src', 'app.js'),
  },
  {
    name: '@lt/web',
    sourceDir: join(repoDir, 'web', 'src'),
    artifact: join(repoDir, 'web', 'dist', 'index.html'),
  },
];

/**
 * Чем звать npm из скрипта.
 *
 * Напрямую нельзя: в Windows npm — это `npm.cmd`, а Node с 20-й версии
 * отказывается запускать `.cmd` без оболочки (`spawnSync npm.cmd EINVAL` —
 * защита от подстановки аргументов). Поэтому берём тот самый npm, которым
 * запущен этот скрипт, и отдаём его текущему Node: одинаково на всех
 * платформах и без оболочки.
 */
const npmRunner = (() => {
  const cli = process.env.npm_execpath;

  if (cli !== undefined && cli.endsWith('.js')) {
    return { command: process.execPath, prefix: [cli] };
  }

  // Скрипт запустили не через npm (`node scripts/build.mjs`): на Unix `npm` —
  // обычная программа и запускается как есть.
  return { command: 'npm', prefix: [] };
})();

/** Время последнего изменения в дереве исходников. */
function newestSourceTime(sourceDir) {
  let newest = 0;

  for (const entry of readdirSync(sourceDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }

  return newest;
}

/**
 * Досбирает рабочие пространства, чьи исходники новее сборки.
 *
 * Сравнение по времени изменения, а не «собрано / не собрано»: в установщик
 * едет собранный код, и вчерашняя сборка сервера рядом со свежими исходниками
 * даёт приложение, которое ведёт себя не так, как репозиторий, — искать такую
 * разницу потом очень дорого.
 */
function buildWorkspaces() {
  for (const workspace of WORKSPACES) {
    const built = existsSync(workspace.artifact) ? statSync(workspace.artifact).mtimeMs : 0;

    if (built > newestSourceTime(workspace.sourceDir)) {
      console.log(`${workspace.name}: сборка актуальна`);

      continue;
    }

    console.log(`${workspace.name}: собираем…`);
    execFileSync(npmRunner.command, [...npmRunner.prefix, 'run', 'build', '-w', workspace.name], {
      cwd: repoDir,
      stdio: 'inherit',
    });
  }
}

/**
 * Общие параметры сборки бандлов.
 *
 * `createRequire` в шапке нужен зависимостям, которые остались в формате CommonJS:
 * в модуле ESM своего `require` нет, а Fastify и его плагины им пользуются.
 */
function bundleOptions(entry, outfile, external) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: NODE_TARGET,
    format: 'esm',
    sourcemap: true,
    // Имена нужны в трассировке стека из журнала: без них разбирать отчёт
    // о падении в установленном приложении нечем.
    minify: false,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    external,
    logLevel: 'info',
  };
}

/** Размер файла в мегабайтах для итогового отчёта. */
function sizeMb(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(1);
}

async function main() {
  buildWorkspaces();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Снаружи бандла остаются два пакета, и у каждого своя причина:
  // - `better-sqlite3` — нативный модуль, в JavaScript его не собрать;
  // - `pdf-parse` — внутри него pdf.js, который при сборке в один файл теряет
  //   свои полифилы браузерных API (`DOMMatrix`) и падает на первом же PDF.
  // Оба приезжают в установщик обычными зависимостями `desktop/package.json`.
  await build(
    bundleOptions(join(desktopDir, 'src', 'serverEntry.ts'), join(outDir, 'server.mjs'), [
      'better-sqlite3',
      'pdf-parse',
    ]),
  );

  // Оболочка: `electron` предоставляет сам исполняемый файл приложения.
  await build(
    bundleOptions(join(desktopDir, 'src', 'main.ts'), join(outDir, 'main.js'), ['electron']),
  );

  cpSync(join(repoDir, 'web', 'dist'), join(outDir, 'web'), { recursive: true });
  cpSync(join(repoDir, 'server', 'src', 'db', 'migrations'), join(outDir, 'migrations'), {
    recursive: true,
  });
  cpSync(join(desktopDir, 'src', 'loading.html'), join(outDir, 'loading.html'));

  // Помощник распознавания для macOS компилируется на машине пользователя, и
  // компилятору нужен обычный файл: внутри архива приложения он его не увидит.
  const scriptsDir = join(desktopDir, 'resources', 'scripts');

  mkdirSync(scriptsDir, { recursive: true });
  cpSync(
    join(repoDir, 'server', 'scripts', 'macos-ocr.swift'),
    join(scriptsDir, 'macos-ocr.swift'),
  );

  console.log(
    [
      '',
      `Оболочка собрана в ${relative(repoDir, outDir)}:`,
      `  main.js     ${sizeMb(join(outDir, 'main.js'))} МБ`,
      `  server.mjs  ${sizeMb(join(outDir, 'server.mjs'))} МБ`,
      '',
    ].join('\n'),
  );
}

await main();
