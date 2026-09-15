/**
 * Публичный API пакета `@lt/shared`: типы и константы, общие для server и web.
 * Все новые модули пакета должны реэкспортироваться отсюда.
 * Относительные импорты внутри пакета — всегда с расширением `.js` (ESM/NodeNext).
 */
export { API_PREFIX, APP_NAME } from './constants.js';
export type { HealthResponse } from './health.js';
