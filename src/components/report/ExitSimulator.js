// src/components/report/ExitSimulator.js
//
// «Симулятор выходов» (Анализ → Мои ошибки): те же сделки периода, но с другим правилом выхода — как в журналах
// трейдера (разбор выходов по всем сделкам). Варианты: факт; «держать до стопа или своей цели»; фиксированная цель
// 1R / 2R / 3R от исходного стопа; и потолок — лучшая цена за время сделки (недостижимо, только для масштаба).
//
// Свечи грузятся по кнопке, по одной сделке (не со страницей): это десятки запросов. Расчёт каждой сделки —
// services/analytics/exitReplay.js. Сделки без стопа в вариантах с R не участвуют — у них нет единицы риска.
import React, { useMemo, useState } from 'react';
import { fetchDailyCandles, recommendTimeframe } from '../../services/marketData/candles';
import { resolveOpenedAt, resolveClosedAt } from '../../services/tradeDates';
import { guessInstrumentType } from '../../services/import/instrumentResolver';
import { buildExitReplay } from '../../services/analytics/exitReplay';

const MAX_TRADES = 40;
const rub = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`);
const sgn = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');

const VARIANTS = [
  { id: 'actual', label: 'Как вышли на деле' },
  { id: 'plan', label: 'Держать до стопа или своей цели', needs: 'stop' },
  { id: 'r1', label: 'Цель 1R', needs: 'stop' },
  { id: 'r2', label: 'Цель 2R', needs: 'stop' },
  { id: 'r3', label: 'Цель 3R', needs: 'stop' },
  { id: 'best', label: 'Потолок: лучшая цена в сделке', ceiling: true },
];

function variantsOf(rp, trade) {
  if (!rp?.actual) return null;
  const take = Number(trade.takeProfit) > 0 ? Number(trade.takeProfit) : null;
  const out = { actual: rp.actual.rub, best: rp.inTrade?.best?.rub ?? null };
  if (rp.riskPerUnit) {
    out.plan = rp.holdUntil(take)?.rub ?? null;
    out.r1 = rp.holdUntil(rp.targetAtR(1))?.rub ?? null;
    out.r2 = rp.holdUntil(rp.targetAtR(2))?.rub ?? null;
    out.r3 = rp.holdUntil(rp.targetAtR(3))?.rub ?? null;
  }
  return out;
}

export default function ExitSimulator({ items, userProfile, label }) {
  const trades = useMemo(() => (items || []).filter((x) => !x.partial && x.src !== 'paper' && x.raw?.status === 'closed').slice(0, MAX_TRADES), [items]);
  const [state, setState] = useState(null); // { running, done, rows: [{x, v, err}] }
  const hasToken = !!userProfile?.tinkoffToken;

  const run = async () => {
    const rows = [];
    setState({ running: true, done: 0, rows });
    for (const x of trades) {
      const t = x.raw;
      try {
        const openedAt = resolveOpenedAt(t);
        const closedAt = x.closed instanceof Date ? x.closed : resolveClosedAt(t);
        const dur = openedAt && closedAt ? (closedAt - openedAt) / 60000 : null;
        const timeframe = t.entryTimeframe || recommendTimeframe(dur, hasToken);
        const after = Math.min(30 * 86400000, Math.max(3 * 86400000, (dur || 0) * 60000 * 2));
        const toDate = new Date(Math.min(Date.now(), (closedAt ? closedAt.getTime() : Date.now()) + after));
        const candles = await fetchDailyCandles({ ticker: x.ticker, instrumentType: t.instrumentType || guessInstrumentType(x.ticker), toDate, tinkoffToken: userProfile?.tinkoffToken, timeframe });
        const rp = buildExitReplay({ trade: t, candles, openedAt, closedAt });
        const v = variantsOf(rp, t);
        rows.push(v ? { x, v } : { x, err: 'нет свечей вокруг сделки' });
      } catch (e) {
        rows.push({ x, err: e.message || 'не загрузились свечи' });
      }
      setState({ running: true, done: rows.length, rows: [...rows] });
    }
    setState({ running: false, done: rows.length, rows: [...rows] });
  };

  const ok = (state?.rows || []).filter((r) => r.v);
  const withStop = ok.filter((r) => r.v.plan != null);
  const totals = VARIANTS.map((vr) => {
    const pool = vr.needs === 'stop' ? withStop : ok;
    const sum = pool.reduce((s, r) => s + (r.v[vr.id] ?? 0), 0);
    const actualSame = pool.reduce((s, r) => s + (r.v.actual ?? 0), 0);
    const better = vr.id === 'actual' ? null : pool.filter((r) => (r.v[vr.id] ?? 0) > (r.v.actual ?? 0)).length;
    return { ...vr, n: pool.length, sum, diff: vr.id === 'actual' ? null : sum - actualSame, better };
  });

  return (
    <div className="card mr-block">
      <div className="section-title">Симулятор выходов</div>
      <p className="mr-note" style={{ marginTop: 0 }}>
        Те же ваши сделки {label ? `за ${label.toLowerCase()}` : ''}, но с другим правилом выхода: держать до стопа или своей цели,
        фиксированная цель в R. Вход и стоп — ваши. Показывается симметрично: где правило заработало бы больше, где меньше.
      </p>
      {!trades.length ? (
        <p className="mr-note" style={{ marginTop: 0 }}>Закрытых реальных сделок за период нет.</p>
      ) : !state ? (
        <button type="button" className="btn btn-secondary" onClick={run}>
          Посчитать по {trades.length} {trades.length === 1 ? 'сделке' : 'сделкам'}{(items || []).length > MAX_TRADES ? ` (первые ${MAX_TRADES})` : ''}
        </button>
      ) : (
        <>
          {state.running && <p className="mr-note" style={{ marginTop: 0 }}>Загружаю свечи: {state.done} из {trades.length}…</p>}
          <div className="xs-table">
            <div className="xs-row xs-head"><span>Правило выхода</span><span>Сделок</span><span>Итог</span><span>Против факта</span><span>Лучше факта</span></div>
            {totals.map((t) => (
              <div key={t.id} className={`xs-row ${t.ceiling ? 'xs-ceiling' : ''}`}>
                <span>{t.label}</span>
                <span>{t.n}</span>
                <b className={`mr-num ${sgn(t.sum)}`}>{t.n ? rub(t.sum) : '—'}</b>
                <b className={`mr-num ${sgn(t.diff)}`}>{t.diff == null || !t.n ? '—' : rub(t.diff)}</b>
                <span>{t.better == null || !t.n ? '—' : `${t.better} из ${t.n}`}</span>
              </div>
            ))}
          </div>
          {!state.running && (
            <p className="mr-note">
              {withStop.length < ok.length ? `У ${ok.length - withStop.length} сделок нет стопа — в вариантах с R и «до стопа или цели» они не участвуют. ` : ''}
              {state.rows.some((r) => r.err) ? `Не посчитано: ${state.rows.filter((r) => r.err).length} (нет свечей). ` : ''}
              Условно: выход по свечам таймфрейма сделки, если в одной свече задеты и стоп, и цель — считается стоп. «Потолок» недостижим —
              он показывает, сколько рынок давал на лучшей точке. Сделок мало — читайте как наблюдение, не как правило.
            </p>
          )}
          {!state.running && <button type="button" className="btn btn-ghost btn-sm" onClick={run}>Пересчитать</button>}
        </>
      )}
    </div>
  );
}
