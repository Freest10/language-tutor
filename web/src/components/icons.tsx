/**
 * Иконки интерфейса.
 *
 * Рисуются кодом, а не грузятся файлами: их две, они простые, и так они
 * наследуют цвет текста (`currentColor`) — значит, одинаково читаются на
 * светлой и тёмной теме и на кнопке любого цвета.
 *
 * Иконки декоративные: смысл кнопки несёт её `aria-label`, поэтому сами они
 * скрыты от экранной читалки.
 */

/** Размер иконки внутри круглой кнопки, пиксели. */
const ICON_SIZE = 20;

/** Общие свойства обеих иконок. */
const shared = {
  width: ICON_SIZE,
  height: ICON_SIZE,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

/** Микрофон: запись реплики голосом. */
export function MicIcon() {
  return (
    <svg {...shared}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

/** Бумажный самолётик: отправка реплики. */
export function SendIcon() {
  return (
    <svg {...shared}>
      <path d="M4 11.5 20 4l-7.5 16-2-6.5z" />
      <path d="m10.5 13.5 9.5-9.5" />
    </svg>
  );
}
