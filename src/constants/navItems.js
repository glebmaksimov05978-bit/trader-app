// src/constants/navItems.js
//
// Single source of truth for nav items — Sidebar.js (desktop) and MobileNav.js (mobile)
// used to keep their own separate hardcoded lists, which drifted: Бэктест was gated
// behind TRUSTED_UIDS on desktop but simply didn't exist on mobile at all (real user
// report — "в мобильном приложении нет раздела Бэктест"). Both now read from here so
// they can't silently diverge again.
//
// Порядок и названия — по решению владельца (2026-11-11…16), каждый раздел отвечает на один вопрос:
//   Главная — коротко «как дела»; Сопровождение — что сейчас и что делать; Журнал — что было на реальные деньги;
//   Анализ — почему так вышло (бывший «Отчёт за месяц»); Стратегии — по каким правилам (правила, проверка на истории,
//   вживую; бывший блок «Капитала» и пункт «Бэктест»); Тренажёр — научиться; Капитал — сколько денег и какой риск;
//   Калькулятор — посчитать сделку; AI Советник; Настройки — подключения.
import React from 'react';
import Icon from '../components/shared/Icon';

export const NAV_ITEMS = [
  { path: '/', icon: <Icon name="dashboard" size={18} />, label: 'Главная' },
  // «Сопровождение» открыто всем: вести открытую позицию, следить за радаром и считать
  // «если закрыть сейчас» полезно с любой стратегией. Части вкладки, завязанные на
  // конкретные системы выхода (профит-/лосс-счёт, история по когортам фиксаций),
  // показываются только той стратегии, которая ими действительно пользуется, — см.
  // usesProfitSystem/usesLossSystem в Cockpit.js.
  { path: '/cockpit', icon: <Icon name="cockpit" size={18} />, label: 'Сопровождение', mobileLabel: 'Ведение' },
  { path: '/journal', icon: <Icon name="journal" size={18} />, label: 'Журнал' },
  { path: '/report', icon: <Icon name="report" size={18} />, label: 'Анализ' },
  { path: '/strategies', icon: <Icon name="backtest" size={18} />, label: 'Стратегии' },
  // Тренажёр открыт всем: учебные сделки на истории и игра на распознавание фигур. Пишет только в свою коллекцию
  // trainerTrades — в Журнал, капитал и отчёты это не попадает.
  { path: '/trainer', icon: <Icon name="target" size={18} />, label: 'Тренажёр' },
  { path: '/capital', icon: <Icon name="capital" size={18} />, label: 'Капитал' },
  { path: '/calculator', icon: <Icon name="calculator" size={18} />, label: 'Калькулятор', mobileLabel: 'Расчёт' },
  { path: '/advisor', icon: <Icon name="advisor" size={18} />, label: 'AI Советник', mobileLabel: 'AI' },
  { path: '/settings', icon: <Icon name="settings" size={18} />, label: 'Настройки' },
];

export const ADMIN_ITEMS = [
  { path: '/admin', icon: <Icon name="admin" size={18} />, label: 'Админ-панель' },
];

// Раньше здесь был «Бэктест» — теперь это вкладка «История» в разделе «Стратегии» (видна тем же доверенным аккаунтам).
export const TRUSTED_ITEMS = [];
