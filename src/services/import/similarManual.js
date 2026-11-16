// src/services/import/similarManual.js
//
// «Это похоже на сделку, которую вы вводили вручную — заменить точными данными?»
// Человек мог записать сделку руками (Журнал, Калькулятор), а потом загрузить её же из Т-Банка или из отчёта. Точное
// совпадение (тот же тикер, сторона, объём и время входа ±2 минуты) импорт и раньше узнавал сам. Здесь — мягкое: время
// записано на глаз, объём немного другой, цена округлена. Такую пару импорт не склеивает молча, а ПРЕДЛАГАЕТ заменить
// ручную запись брокерской (решение владельца, 2026-11-16: «подскажет лучше заменить»).
//
// Чистые функции, без базы.

const DAY = 86400000;
// Насколько далеко по времени может быть ручная запись от брокерской: день сделки мог быть записан не тем числом
// (вечерняя сессия, запись на следующее утро).
const MAX_GAP_MS = 3 * DAY;

const norm = (s) => String(s || '').trim().toUpperCase();

function openedMs(t) {
  const v = t?.openedAt ?? t?.date;
  if (!v) return NaN;
  const d = v?.toDate ? v.toDate() : new Date(v);
  return d.getTime();
}

// Ручная запись — у неё нет номеров сделок брокера, и она не загружена из отчёта.
export function isManualRecord(t) {
  if (!t || t.status === 'pending' || t.status === 'cancelled') return false;
  if (Array.isArray(t.sourceTransactionIds) && t.sourceTransactionIds.length) return false;
  if (t.dataSource === 'imported' || t.dataSource === 'hybrid') return false;
  if (t.isPaper || t.paper || t.source === 'paper') return false;
  // Открыта заявкой из приложения — это уже брокерские данные, не ручная запись.
  if (t.orderId) return false;
  return true;
}

/**
 * Насколько ручная запись похожа на брокерскую позицию. null — не похожа.
 * Чем меньше число, тем ближе (часы разницы во времени + штраф за разницу в объёме и цене).
 */
export function similarityScore(candidate, manual) {
  if (!isManualRecord(manual)) return null;
  if (norm(candidate.ticker) !== norm(manual.ticker)) return null;
  if ((candidate.direction || 'long') !== (manual.direction || 'long')) return null;
  const a = openedMs(candidate);
  const b = openedMs(manual);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const gap = Math.abs(a - b);
  if (gap > MAX_GAP_MS) return null;
  const va = Number(candidate.volume) || 0;
  const vb = Number(manual.volume) || 0;
  if (!(va > 0) || !(vb > 0)) return null;
  const volRatio = Math.max(va, vb) / Math.min(va, vb);
  if (volRatio > 2) return null; // объём отличается больше чем вдвое — это уже другая сделка
  const pa = Number(candidate.entryPrice) || 0;
  const pb = Number(manual.entryPrice) || 0;
  const priceGap = pa > 0 && pb > 0 ? Math.abs(pa - pb) / pa : 0;
  if (priceGap > 0.05) return null; // цена входа дальше 5 % — не та сделка
  return gap / 3600000 + (volRatio - 1) * 24 + priceGap * 400;
}

/** Самая похожая ручная запись, ещё не занятая другой позицией этого же импорта. */
export function findSimilarManual(candidate, existingTrades, usedIds = new Set()) {
  let best = null;
  let bestScore = Infinity;
  for (const t of existingTrades || []) {
    if (!t?.id || usedIds.has(t.id)) continue;
    const s = similarityScore(candidate, t);
    if (s != null && s < bestScore) { best = t; bestScore = s; }
  }
  return best;
}

/** Короткое описание ручной записи для окна импорта: «12.03 10:15 · 10 шт. по 250,5». */
export function describeManual(t) {
  const ms = openedMs(t);
  const when = Number.isFinite(ms)
    ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'дата не указана';
  const vol = Number(t.volume) || 0;
  const price = Number(t.entryPrice);
  return `${when} · ${vol.toLocaleString('ru-RU')} по ${Number.isFinite(price) ? price.toLocaleString('ru-RU', { maximumFractionDigits: 6 }) : '—'}`;
}
