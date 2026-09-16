/**
 * Окружение тестов: значения по умолчанию из схемы, а не из `.env` разработчика.
 *
 * `config/env.ts` читает `.env` в корне монорепо при первом импорте, и без этой
 * страховки набор тестов зависел бы от того, чем настроена машина: имя модели
 * в `LLM_MODEL`, провайдер голоса или режим распознавания сканов меняли бы
 * ожидания тестов, которые проверяют как раз поведение по умолчанию. Падал бы
 * при этом не тот тест, который что-то сломал, а тот, кому не повезло с
 * конфигурацией.
 *
 * Переменные проставляются до импорта кода сервера (setup-файл выполняется
 * раньше самого теста), а `dotenv` уже заданное значение не перетирает —
 * поэтому `.env` до тестов не доходит. Тест, которому нужна другая
 * конфигурация, меняет `process.env` у себя и возвращает значение обратно.
 */

/** Значения совпадают с умолчаниями `envSchema`: тесты проверяют именно их. */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  WEB_PORT: '5173',
  CONFIG_SOURCE: 'env',
  // Пустая строка означает «переменная не задана»: база и каталог загрузок
  // задаются самими тестами (`openDatabase(IN_MEMORY_DB_PATH)`, `setUploadDir()`).
  DB_PATH: '',
  UPLOAD_DIR: './data/uploads',
  MAX_UPLOAD_MB: '200',
  MAX_MATERIAL_TEXT_CHARS: '',
  SCAN_MODE: 'ocr',
  SCAN_DPI: '150',
  SCAN_MAX_PAGES: '50',
  SCAN_OCR_LANGS: 'en-US,ru-RU',
  OCR_SCRIPTS_DIR: '',
  SCAN_VISION_MODEL: 'qwen3-vl:8b-instruct',
  CORS_ORIGIN: '',
  // Раздача интерфейса сервером выключена: тесты проверяют API, а собранного
  // `web/dist` в прогоне может не быть вовсе.
  WEB_DIST_DIR: '',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_MODEL: 'qwen3:8b',
  LLM_API_KEY: '',
  LLM_TIMEOUT_MS: '120000',
  LLM_TEMPERATURE: '0.3',
  STT_PROVIDER: 'browser',
  STT_BASE_URL: '',
  STT_MODEL: '',
  STT_API_KEY: '',
  STT_REQUIRE_WAV16: 'false',
  TTS_PROVIDER: 'browser',
  TTS_BASE_URL: '',
  TTS_MODEL: '',
  TTS_API_KEY: '',
  TTS_VOICE: '',
  TTS_FORMAT: 'mp3',
};

for (const [name, value] of Object.entries(TEST_ENV)) {
  process.env[name] = value;
}
