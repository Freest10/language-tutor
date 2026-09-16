/**
 * Раскладка файлов десктопной сборки.
 *
 * Главное здесь — что база и материалы не оказываются внутри приложения:
 * каталог программы доступен только для чтения, и попытка писать туда
 * выглядела бы как поломка на ровном месте после установки обновления.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePaths, resolveWhisperModel, whisperBinaryName } from '../src/paths.js';

/** Путь с прямыми слэшами: в Windows `join` даёт обратные, и сравнение с
 * образцом ломалось бы на разделителе, а не на сути. */
function posix(path: string): string {
  return path.split(sep).join('/');
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lt-paths-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  const paths = (platform: NodeJS.Platform = 'darwin') =>
    resolvePaths({
      appDir: '/Applications/language-tutor.app/Contents/Resources/app.asar',
      resourcesDir: '/Applications/language-tutor.app/Contents/Resources',
      userDataDir: '/Users/tester/Library/Application Support/language-tutor',
      platform,
    });

  it('держит данные пользователя вне каталога приложения', () => {
    const resolved = paths();

    for (const path of [
      resolved.dbFile,
      resolved.uploadDir,
      resolved.settingsFile,
      resolved.logDir,
    ]) {
      expect(path).toContain('/Users/tester/');
      expect(path).not.toContain('app.asar');
    }
  });

  it('ищет интерфейс и миграции внутри приложения', () => {
    expect(paths().webDistDir).toContain('app.asar');
  });

  it('кладёт распознаватель рядом с приложением, а не внутрь архива', () => {
    const resolved = paths();

    expect(resolved.whisperBin).not.toContain('app.asar');
    expect(resolved.whisperModelDir).not.toContain('app.asar');
  });

  it('знает, где лежит иконка для запуска из исходников', () => {
    // В доке у запуска из исходников иначе висит логотип Electron.
    expect(posix(paths().appIconFile).endsWith('build-assets/icon.png')).toBe(true);
  });

  it('знает про расширение исполняемого файла в Windows', () => {
    expect(whisperBinaryName('win32')).toBe('whisper-server.exe');
    expect(whisperBinaryName('darwin')).toBe('whisper-server');
    expect(paths('win32').whisperBin.endsWith('.exe')).toBe(true);
  });
});

describe('resolveWhisperModel', () => {
  it('берёт абсолютный путь как есть', () => {
    const absolute = join(workDir, 'ggml-large.bin');

    expect(resolveWhisperModel(absolute, { userModelDir: workDir, bundledModelDir: workDir })).toBe(
      absolute,
    );
  });

  it('предпочитает модель пользователя модели из установщика', () => {
    const userModelDir = join(workDir, 'models');
    const bundledModelDir = join(workDir, 'bundled');

    mkdirSync(userModelDir);
    mkdirSync(bundledModelDir);
    writeFileSync(join(userModelDir, 'ggml-base.bin'), 'модель');

    expect(resolveWhisperModel('ggml-base.bin', { userModelDir, bundledModelDir })).toBe(
      join(userModelDir, 'ggml-base.bin'),
    );
  });

  it('возвращается к модели из установщика, если своей нет', () => {
    const userModelDir = join(workDir, 'models');
    const bundledModelDir = join(workDir, 'bundled');

    expect(resolveWhisperModel('ggml-base.bin', { userModelDir, bundledModelDir })).toBe(
      join(bundledModelDir, 'ggml-base.bin'),
    );
  });
});
