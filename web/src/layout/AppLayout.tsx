/**
 * Каркас страницы: боковая навигация, предупреждения о возможностях и содержимое.
 *
 * Предупреждения живут здесь, а не на отдельной странице: если голосовой режим
 * не работает (например, в браузере нет Web Speech API — допущение A14),
 * пользователь должен узнать об этом до того, как нажмёт на микрофон.
 */
import { Outlet } from 'react-router-dom';

import { NavBar } from './NavBar';

import { useCapabilities, type VoiceCapabilityState } from '../context/CapabilitiesProvider';
import { useApiErrorMessage, useT } from '../i18n/useT';

/** Ключ предупреждения и подстановки к нему. */
interface CapabilityWarning {
  id: string;
  messageKey: string;
  reason: string;
}

/** Предупреждение о недоступности распознавания или синтеза речи. */
function voiceWarning(kind: 'stt' | 'tts', state: VoiceCapabilityState): CapabilityWarning | null {
  if (!state.blocker || state.blocker === 'config_unavailable') {
    return null;
  }

  if (state.blocker === 'server_not_configured') {
    return {
      id: `${kind}-server`,
      messageKey: `capabilities.warnings.${kind}ServerUnavailable`,
      reason: state.reason ?? '',
    };
  }

  if (state.runsInBrowser) {
    return {
      id: `${kind}-browser`,
      messageKey: `capabilities.warnings.${kind}BrowserMissing`,
      reason: '',
    };
  }

  // Серверный провайдер настроен, но браузер не умеет записывать звук.
  return {
    id: `${kind}-recording`,
    messageKey: 'capabilities.warnings.microphoneMissing',
    reason: '',
  };
}

/** Полоса с предупреждениями: показывается, только когда есть о чём предупредить. */
function CapabilityWarnings() {
  const t = useT();
  const toErrorMessage = useApiErrorMessage();
  const { status, error, llm, stt, tts, refresh } = useCapabilities();

  if (status === 'loading') {
    return null;
  }

  if (status === 'error') {
    return (
      <div className="lt-banner lt-banner--error" role="alert">
        <p className="lt-banner__title">{t('capabilities.warnings.configUnavailable')}</p>
        <p>{toErrorMessage(error)}</p>
        <button type="button" className="lt-button" onClick={refresh}>
          {t('actions.retry')}
        </button>
      </div>
    );
  }

  const warnings: CapabilityWarning[] = [];

  if (!llm.available) {
    warnings.push({
      id: 'llm',
      messageKey: 'capabilities.warnings.llmUnavailable',
      reason: llm.reason ?? '',
    });
  }

  for (const warning of [voiceWarning('stt', stt), voiceWarning('tts', tts)]) {
    if (warning) {
      warnings.push(warning);
    }
  }

  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="lt-banner" role="status">
      <p className="lt-banner__title">{t('capabilities.warnings.title')}</p>
      <ul className="lt-banner__list">
        {warnings.map((warning) => (
          <li key={warning.id}>{t(warning.messageKey, { reason: warning.reason })}</li>
        ))}
      </ul>
    </div>
  );
}

/** Каркас всех страниц приложения. */
export function AppLayout() {
  const t = useT();

  return (
    <div className="lt-shell">
      <a className="lt-skip-link" href="#lt-main">
        {t('nav.skipToContent')}
      </a>
      <NavBar />
      <main id="lt-main" className="lt-main" tabIndex={-1}>
        <CapabilityWarnings />
        <Outlet />
      </main>
    </div>
  );
}
