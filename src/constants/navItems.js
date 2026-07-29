// src/constants/navItems.js
//
// Single source of truth for nav items — Sidebar.js (desktop) and MobileNav.js (mobile)
// used to keep their own separate hardcoded lists, which drifted: Бэктест was gated
// behind TRUSTED_UIDS on desktop but simply didn't exist on mobile at all (real user
// report — "в мобильном приложении нет раздела Бэктест"). Both now read from here so
// they can't silently diverge again.
export const NAV_ITEMS = [
  { path: '/', icon: '📊', label: 'Дашборд' },
  { path: '/calculator', icon: '🧮', label: 'Калькулятор', mobileLabel: 'Расчёт' },
  { path: '/journal', icon: '📓', label: 'Журнал' },
  { path: '/capital', icon: '💰', label: 'Капитал' },
  { path: '/advisor', icon: '🤖', label: 'AI Советник', mobileLabel: 'AI' },
  { path: '/settings', icon: '⚙️', label: 'Настройки' },
];

export const ADMIN_ITEMS = [
  { path: '/admin', icon: '🛡️', label: 'Админ-панель' },
];

// Внутренний инструмент, не готовый для клиентов — виден админам и тому же списку
// доверенных аккаунтов, что обходит стену верификации почты (см. TRUSTED_UIDS).
export const TRUSTED_ITEMS = [
  { path: '/backtest', icon: '🧪', label: 'Бэктест' },
];
