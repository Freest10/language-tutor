/**
 * Голос: распознавание речи и синтез на стороне сервера.
 *
 * При `STT_PROVIDER=browser` / `TTS_PROVIDER=browser` эти эндпоинты остаются
 * отключёнными и отвечают 501 `not_configured` — работу выполняет браузер.
 *
 * - `POST /api/voice/stt`;
 * - `POST /api/voice/tts`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Голосовые маршруты. */
export const voiceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/voice/stt', notImplementedRoute('POST /api/voice/stt'));
  app.post('/voice/tts', notImplementedRoute('POST /api/voice/tts'));
};
