// src/services/cockpitPrefs.js
//
// Вид Сопровождения под себя (Настройки → Сопровождение): какие списки слева, высота графика, какая вкладка под
// графиком открывается первой, где панель управления, раскрыты ли «Сделки системы». Хранится в профиле
// (`cockpitPrefs`); чего нет — берётся по умолчанию, поэтому старые профили выглядят как раньше.

export const COCKPIT_PREFS_DEFAULT = {
  showPositions: true,
  showPaper: true,
  showRadar: true,
  paperOpen: false,
  chartHeight: 'normal',   // 'compact' | 'normal' | 'tall'
  firstTab: 'auto',        // 'auto' | 'ta' — «Позиция»/«Вход» или сразу «Тех. анализ»
  orderPanel: 'right',     // 'right' | 'below'
};

export const CHART_HEIGHTS = { compact: 360, normal: 460, tall: 620 };

export function getCockpitPrefs(profile) {
  const p = profile?.cockpitPrefs || {};
  const out = { ...COCKPIT_PREFS_DEFAULT };
  for (const k of ['showPositions', 'showPaper', 'showRadar', 'paperOpen']) if (typeof p[k] === 'boolean') out[k] = p[k];
  if (CHART_HEIGHTS[p.chartHeight]) out.chartHeight = p.chartHeight;
  if (p.firstTab === 'ta' || p.firstTab === 'auto') out.firstTab = p.firstTab;
  if (p.orderPanel === 'right' || p.orderPanel === 'below') out.orderPanel = p.orderPanel;
  return out;
}
