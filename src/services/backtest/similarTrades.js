// src/services/backtest/similarTrades.js
//
// Честный поиск «похожих ситуаций» для блока истории в «Сопровождении» — без
// выдуманных чисел. Датасет (public/data/backtestSample.json) — это тот же эталонный
// дневной бэктест, которым эта сессия сверяла все свои находки (36 тикеров MOEX,
// mom3>1, стандартные EXIT_RULES). Похожесть определяется по когорте (сколько раз
// сработала профит-система) и направлению — той же стадии сделки, что видна на экране
// прямо сейчас, а не по цене или тикеру, которые для этого вопроса не важны.
let cached = null;

export async function loadBacktestSample() {
  if (cached) return cached;
  try {
    const res = await fetch('/data/backtestSample.json');
    if (!res.ok) return null;
    cached = await res.json();
    return cached;
  } catch {
    return null;
  }
}

/**
 * @param {object} sample - результат loadBacktestSample()
 * @param {{cohort: string, direction: 'long'|'short'}} state
 * @returns {{n, deciles, exitReasons, mnote}|null}
 */
export function findSimilar(sample, { cohort, direction }) {
  if (!sample?.trades?.length) return null;
  const pool = sample.trades.filter((t) => t.cohort === cohort && t.dir === direction);
  if (pool.length < 20) return null; // выборка меньше 20 — честнее промолчать, чем соврать

  const sorted = [...pool].map((t) => t.pnl).sort((a, b) => a - b);
  const decileAt = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  const deciles = Array.from({ length: 10 }, (_, i) => decileAt(i / 9));

  const byReason = {};
  for (const t of pool) (byReason[t.reason] ??= []).push(t);
  const exitReasons = Object.entries(byReason)
    .map(([reason, list]) => ({
      reason, count: list.length, share: list.length / pool.length,
      avgPnl: list.reduce((s, t) => s + t.pnl, 0) / list.length,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    n: pool.length,
    timeframe: sample.timeframe,
    deciles,
    exitReasons,
    avgBars: pool.reduce((s, t) => s + (t.bars || 0), 0) / pool.length,
  };
}

/** Вероятность дойти до цели, интерполируя по децилям — тот же приём, что в макете, но на честных числах. */
export function probabilityOfGoal(deciles, goalPct) {
  const n = deciles.length;
  if (goalPct <= deciles[0]) return 97;
  if (goalPct >= deciles[n - 1]) return 3;
  for (let i = 0; i < n - 1; i++) {
    if (goalPct >= deciles[i] && goalPct <= deciles[i + 1]) {
      const frac = (goalPct - deciles[i]) / ((deciles[i + 1] - deciles[i]) || 1);
      const pAtI = 100 - (i / (n - 1)) * 100;
      const pAtI1 = 100 - ((i + 1) / (n - 1)) * 100;
      return Math.round(pAtI + (pAtI1 - pAtI) * frac);
    }
  }
  return 50;
}
