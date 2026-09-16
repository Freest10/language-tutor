import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Главный процесс и запуск дочерних процессов проверяются запуском самого
      // приложения: подделывать здесь Electron и whisper.cpp смысла нет.
      exclude: ['src/main.ts', 'src/menu.ts', 'src/serverEntry.ts'],
    },
  },
});
