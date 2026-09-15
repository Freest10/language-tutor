/**
 * Главная страница: краткое состояние приложения и возможности сервера.
 *
 * Здесь же видно, кто выполняет распознавание и синтез речи, — это первое,
 * что нужно проверить, если голосовой режим ведёт себя не так, как ожидалось.
 */
import { useCapabilities, type VoiceCapabilityState } from '../context/CapabilitiesProvider';
import { useApiErrorMessage, useT } from '../i18n/useT';

/** Строка с описанием голосовой возможности: кто выполняет и доступна ли она. */
function VoiceFact({ label, state }: { label: string; state: VoiceCapabilityState }) {
  const t = useT();
  const provider =
    state.provider === null
      ? '—'
      : state.provider === 'browser'
        ? t('capabilities.providerBrowser')
        : t('capabilities.providerServer', { provider: state.provider });

  return (
    <>
      <dt>{label}</dt>
      <dd>
        {provider} — {state.available ? t('capabilities.available') : t('capabilities.unavailable')}
      </dd>
    </>
  );
}

/** Главная страница приложения. */
export function HomePage() {
  const t = useT();
  const toErrorMessage = useApiErrorMessage();
  const { status, config, error, refresh, llm, stt, tts } = useCapabilities();

  return (
    <section className="lt-page" aria-labelledby="lt-home-title">
      <h1 id="lt-home-title" className="lt-page__title">
        {t('home.title')}
      </h1>
      <p className="lt-page__lead">{t('home.subtitle')}</p>

      <section className="lt-card" aria-labelledby="lt-home-capabilities">
        <h2 id="lt-home-capabilities">{t('capabilities.title')}</h2>

        {status === 'loading' && <p role="status">{t('capabilities.checking')}</p>}

        {status === 'error' && (
          <div role="alert">
            <p>{t('capabilities.unreadable')}</p>
            <p>{toErrorMessage(error)}</p>
            <button type="button" className="lt-button" onClick={refresh}>
              {t('actions.retry')}
            </button>
          </div>
        )}

        {status === 'ready' && config && (
          <dl className="lt-facts">
            <dt>{t('capabilities.llm')}</dt>
            <dd>
              {llm.available
                ? (llm.model ?? t('capabilities.available'))
                : t('capabilities.unavailable')}
            </dd>
            <VoiceFact label={t('capabilities.stt')} state={stt} />
            <VoiceFact label={t('capabilities.tts')} state={tts} />
            <dt>{t('capabilities.version')}</dt>
            <dd>{config.version}</dd>
          </dl>
        )}
      </section>
    </section>
  );
}
