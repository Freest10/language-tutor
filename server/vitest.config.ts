import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Окружение — раньше всего: код сервера читает `.env` при первом импорте.
    // Следом заглушка `fetch`: сеть из тестов недоступна.
    setupFiles: ['./test/setup/env.ts', './test/setup/noNetwork.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
