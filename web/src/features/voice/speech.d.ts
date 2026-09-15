/**
 * Типы распознавания речи из Web Speech API.
 *
 * В `lib.dom.d.ts` описаны только результаты распознавания
 * (`SpeechRecognitionResult`, `SpeechRecognitionResultList`,
 * `SpeechRecognitionAlternative`) и весь синтез (`speechSynthesis`), но нет ни
 * самого `SpeechRecognition`, ни его событий: спецификация до сих пор черновик,
 * а в Firefox распознавания нет вовсе (допущение A14). Поэтому недостающая
 * часть описана здесь — ровно то, чем пользуется `useSpeechRecognition`.
 *
 * Файл глобальный (без импортов и экспортов): типы дополняют `Window`
 * и доступны во всём пакете без импорта.
 */

/** Событие с промежуточными и финальными результатами распознавания. */
interface SpeechRecognitionEvent extends Event {
  /** Индекс первого изменившегося результата в `results`. */
  readonly resultIndex: number;
  /** Накопленные результаты: промежуточные — с `isFinal: false`. */
  readonly results: SpeechRecognitionResultList;
}

/** Код отказа распознавания. */
type SpeechRecognitionErrorCode =
  /** Распознавание остановлено вызовом `abort()`. */
  | 'aborted'
  /** Нет доступа к звуку с микрофона. */
  | 'audio-capture'
  | 'bad-grammar'
  /** Язык не поддерживается движком распознавания. */
  | 'language-not-supported'
  /** Движку распознавания нужна сеть, и она недоступна. */
  | 'network'
  /** Пользователь запретил доступ к микрофону. */
  | 'not-allowed'
  /** В записи не нашлось речи. */
  | 'no-speech'
  /** Доступ к сервису распознавания запрещён системой или политикой страницы. */
  | 'service-not-allowed';

/** Событие отказа распознавания. */
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode;
  /** Пояснение движка; часто пустая строка. */
  readonly message: string;
}

/** Распознаватель речи браузера. */
interface SpeechRecognition extends EventTarget {
  /** Язык распознавания в нотации BCP-47; ставится до `start()`. */
  lang: string;
  /** Продолжать ли распознавание после первой законченной фразы. */
  continuous: boolean;
  /** Присылать ли промежуточные результаты по ходу речи. */
  interimResults: boolean;
  /** Сколько вариантов расшифровки просить у движка. */
  maxAlternatives: number;
  /** Начинает распознавание; повторный вызов без остановки бросает исключение. */
  start(): void;
  /** Останавливает распознавание и отдаёт накопленный результат. */
  stop(): void;
  /** Прерывает распознавание, результат не отдаётся. */
  abort(): void;
  onaudiostart: ((this: SpeechRecognition, event: Event) => void) | null;
  onaudioend: ((this: SpeechRecognition, event: Event) => void) | null;
  onstart: ((this: SpeechRecognition, event: Event) => void) | null;
  onend: ((this: SpeechRecognition, event: Event) => void) | null;
  onresult: ((this: SpeechRecognition, event: SpeechRecognitionEvent) => void) | null;
  onnomatch: ((this: SpeechRecognition, event: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, event: SpeechRecognitionErrorEvent) => void) | null;
  onspeechstart: ((this: SpeechRecognition, event: Event) => void) | null;
  onspeechend: ((this: SpeechRecognition, event: Event) => void) | null;
}

/** Конструктор распознавателя речи. */
interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
  prototype: SpeechRecognition;
}

interface Window {
  /** Стандартное имя конструктора распознавателя; в Firefox отсутствует (A14). */
  SpeechRecognition?: SpeechRecognitionConstructor;
  /** Имя конструктора в Chrome, Edge и Safari. */
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
