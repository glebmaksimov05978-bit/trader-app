// src/components/shared/Icon.js
//
// Единый набор тонких линейных иконок вместо эмодзи. Эмодзи рисуются по-разному на разных
// устройствах и сразу придают интерфейсу «детский» вид; здесь все иконки одной толщины линии,
// цвета текущего текста (currentColor) и одного размера. Рисунки — простые контуры 24×24.
//
// <Icon name="chart" size={16} />  — размер в пикселях, по умолчанию 18.
import React from 'react';

const P = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  calculator: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 7h8" /><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" /></>,
  journal: <><path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z" /><path d="M6 3v18" /><path d="M10 8h6M10 12h6" /></>,
  report: <><path d="M5 3h10l4 4v14H5z" /><path d="M15 3v4h4" /><path d="M9 13h6M9 17h4" /></>,
  cockpit: <><circle cx="12" cy="12" r="9" /><path d="M12 12l4-3" /><path d="M12 7v1M7 12h1M17 12h-1" /></>,
  capital: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><path d="M16 15h2" /></>,
  advisor: <><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
  backtest: <><path d="M9 3h6" /><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" /><path d="M8 15h8" /></>,
  admin: <><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 15l3-4 3 2 5-6" /></>,
  candles: <><path d="M7 4v3M7 15v4M17 6v3M17 17v3" /><rect x="5" y="7" width="4" height="8" rx="1" /><rect x="15" y="9" width="4" height="8" rx="1" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12l6-4" /></>,
  bolt: <><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></>,
  bell: <><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z" /><path d="M10 21h4" /></>,
  send: <><path d="M21 3L3 10l7 3 3 7z" /><path d="M10 13l11-10" /></>,
  repeat: <><path d="M17 3l3 3-3 3" /><path d="M4 11V9a3 3 0 0 1 3-3h13" /><path d="M7 21l-3-3 3-3" /><path d="M20 13v2a3 3 0 0 1-3 3H4" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-4L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14 4l2-2" /><path d="M20 20v-5h-5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  close: <><path d="M6 6l12 12M18 6L6 18" /></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  warning: <><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18h.01" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>,
  save: <><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7V3" /><path d="M8 21v-6h8v6" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  upload: <><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 20h14" /></>,
  download: <><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></>,
  moon: <><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></>,
  chevronDown: <><path d="M6 9l6 6 6-6" /></>,
  chevronRight: <><path d="M9 6l6 6-6 6" /></>,
  chevronUp: <><path d="M6 15l6-6 6 6" /></>,
  arrowUp: <><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></>,
  arrowDown: <><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  logout: <><path d="M10 4H5v16h5" /><path d="M15 8l4 4-4 4" /><path d="M9 12h10" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  filter: <><path d="M4 5h16l-6 7v6l-4 2v-8z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 10h16" /><path d="M9 3v4M15 3v4" /></>,
  money: <><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5" /><path d="M12 6.5V8M12 16v1.5" /></>,
  trendUp: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  trendDown: <><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></>,
  flask: <><path d="M9 3h6" /><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
};

export default function Icon({ name, size = 18, strokeWidth = 1.75, className = '', style }) {
  const body = P[name];
  if (!body) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ${className}`.trim()}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(P);
