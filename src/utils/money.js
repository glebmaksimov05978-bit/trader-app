// src/utils/money.js
//
// Деньги и проценты для экранов, без «−0». Округление отрицательной мелочи (−0,3 → −0) давало
// «−0 ₽» и «−0,0%» у сделок, закрытых с крошечным убытком: выглядело как ошибка. Здесь мелочь
// показывается с копейками, а настоящий ноль — без знака.
import { formatCurrency as baseCurrency } from './calculator';

/** Рубли: целые, но если сумма по модулю меньше рубля и не ноль — с копейками; −0 → 0. */
export function formatCurrency(n) {
  const v = Number(n);
  if (n === undefined || n === null || Number.isNaN(v)) return '—';
  if (v !== 0 && Math.abs(v) < 1) {
    return v.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return baseCurrency(Math.round(v) || 0);
}

/** Процент со знаком: нулевой — «0,00%», микроскопический — «<0,01%». */
export function formatPercent(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const eps = Math.pow(10, -digits);
  if (Math.abs(n) < eps / 2) return n === 0 ? `0${digits ? ',' + '0'.repeat(digits) : ''}%` : `${n > 0 ? '+' : '−'}<${eps.toString().replace('.', ',')}%`;
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits).replace('.', ',')}%`;
}

/** Русское склонение: plural(1, ['сделка','сделки','сделок']) → «сделка». */
export function plural(n, forms) {
  const a = Math.abs(Math.trunc(Number(n) || 0)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
export const tradesWord = (n) => `${n} ${plural(n, ['сделка', 'сделки', 'сделок'])}`;
