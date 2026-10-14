// src/constants/navItems.js
//
// Single source of truth for nav items — Sidebar.js (desktop) and MobileNav.js (mobile)
// used to keep their own separate hardcoded lists, which drifted: Бэктест was gated
// behind TRUSTED_UIDS on desktop but simply didn't exist on mobile at all (real user
// report — "в мобильном приложении нет раздела Бэктест"). Both now read from here so
// they can't silently diverge again.
import React from 'react';
import Icon from '../components/shared/Icon';

export const NAV_ITEMS = [
  { path: '/', icon: <Icon name="dashboard" size={18} />, label: 'Дашборд' },
  { path: '/calculator', icon: <Icon name="calculator" size={18} />, label: 'Калькулятор', mobileLabel: 'Расчёт' },
  { path: '/journal', icon: <Icon name="journal" size={18} />, label: 'Журнал' },
  { path: '/report', icon: <Icon name="report" size={18} />, label: 'Отчёт за месяц', mobileLabel: 'Отчёт' },
  // «Сопровождение» открыто всем: вести открытую позицию, следить за радаром и считать
  // «если закрыть сейчас» полезно с любой стратегией. Части вкладки, завязанные на
  // конкретные системы выхода (профит-/лосс-счёт, история по когортам фиксаций),
  // показываются только той стратегии, которая ими действительно пользуется, — см.
  // usesProfitSystem/usesLossSystem в Cockpit.js.
  { path: '/cockpit', icon: <Icon name="cockpit" size={18} />, label: 'Сопровождение', mobileLabel: 'Ведение' },
  { path: '/capital', icon: <Icon name="capital" size={18} />, label: 'Капитал' },
  { path: '/advisor', icon: <Icon name="advisor" size={18} />, label: 'AI Советник', mobileLabel: 'AI' },
  { path: '/settings', icon: <Icon name="settings" size={18} />, label: 'Настройки' },
];

export const ADMIN_ITEMS = [
  { path: '/admin', icon: <Icon name="admin" size={18} />, label: 'Админ-панель' },
];

// Внутренний инструмент, не готовый для клиентов — виден админам и тому же списку
// доверенных аккаунтов, что обходит стену верификации почты (см. TRUSTED_UIDS).
export const TRUSTED_ITEMS = [
  { path: '/backtest', icon: <Icon name="backtest" size={18} />, label: 'Бэктест' },
];
