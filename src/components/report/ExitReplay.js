// src/components/report/ExitReplay.js
//
// «Переигровка выхода» в окне сделки (Анализ): ползунок по свечам после входа — до фактического выхода и после него.
// На каждой точке — сколько было бы в рублях и в R и разница с фактом. Отмечены лучшая и худшая цена за время сделки,
// где сработал бы стоп и что цена сделала после выхода. Расчёт — services/analytics/exitReplay.js.
import React, { useEffect, useMemo, useState } from 'react';
import { buildExitReplay } from '../../services/analytics/exitReplay';

const rub = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`);
const rr = (v) => (v == null ? null : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2).replace('.', ',')}R`);
const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2).replace('.', ',')}%`);
const px = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }));
const when = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const cls = (v) => (v == null ? '' : v >= 0 ? 'xr-up' : 'xr-down');

export default function ExitReplay({ trade, candles, openedAt, closedAt, timeframeLabel }) {
  const rp = useMemo(() => buildExitReplay({ trade, candles, openedAt, closedAt }), [trade, candles, openedAt, closedAt]);
  const [cursor, setCursor] = useState(null);
  // Новая сделка или другой таймфрейм — точка выхода снова на фактическом выходе.
  useEffect(() => { setCursor(null); }, [candles, trade?.id]);
  if (!rp) return null;

  const idx = cursor ?? (rp.exitIdx ?? rp.lastIdx);
  const cur = rp.exitAtBar(idx);
  const isActual = rp.actual && idx === rp.exitIdx && cursor == null;
  const shown = isActual ? rp.actual : cur;
  const diff = rp.actual && shown.rub != null && rp.actual.rub != null && !isActual ? shown.rub - rp.actual.rub : null;

  // --- мини-график: от нескольких свечей до входа до конца загруженных ---
  const from = Math.max(0, rp.entryIdx - 6);
  const view = candles.slice(from, rp.lastIdx + 1);
  const W = 720, H = 210, L = 8, R = 8, T = 12, B = 22;
  const lows = view.map((c) => Number(c.low)), highs = view.map((c) => Number(c.high));
  let lo = Math.min(...lows, rp.entry, rp.stop || Infinity), hi = Math.max(...highs, rp.entry, rp.stop || -Infinity);
  if (!(hi > lo)) { hi = lo + 1; }
  const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;
  const n = view.length;
  const x = (i) => L + ((i - from + 0.5) / n) * (W - L - R);
  const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
  const bw = Math.max(1, Math.min(8, ((W - L - R) / n) * 0.6));
  const holdTo = rp.exitIdx ?? rp.lastIdx;

  const jump = (i) => setCursor(i);
  const quick = [
    rp.actual && { id: 'actual', label: 'Фактический выход', on: () => setCursor(null), active: cursor == null },
    rp.inTrade?.best && { id: 'best', label: 'Лучшая цена в сделке', on: () => jump(rp.inTrade.best.idx), active: cursor === rp.inTrade.best.idx },
    rp.stopHit && { id: 'stop', label: 'Где сработал бы стоп', on: () => jump(rp.stopHit.idx), active: cursor === rp.stopHit.idx },
    rp.afterExit?.best && { id: 'after', label: 'Лучшая цена после выхода', on: () => jump(rp.afterExit.best.idx), active: cursor === rp.afterExit.best.idx },
    { id: 'end', label: 'Конец графика', on: () => jump(rp.lastIdx), active: cursor === rp.lastIdx },
  ].filter(Boolean);

  // Выводы — короткими фразами, только то, что посчитано.
  const facts = [];
  if (rp.inTrade?.best && (rp.inTrade.best.price - rp.entry) * rp.dir > 0) {
    facts.push(<>Пока сделка была открыта, лучшая цена — <b>{px(rp.inTrade.best.price)}</b> ({when(rp.inTrade.best.date)}): это <b className="xr-up">{rub(rp.inTrade.best.rub)}</b>{rp.inTrade.best.r != null && <> ({rr(rp.inTrade.best.r)})</>}.
      {rp.captured != null && <> Выход забрал <b>{Math.round(Math.max(0, rp.captured) * 100)}%</b> этого хода.</>}</>);
  }
  if (rp.inTrade?.worst && (rp.inTrade.worst.price - rp.entry) * rp.dir < 0) {
    facts.push(<>Худшая цена — <b>{px(rp.inTrade.worst.price)}</b>: <b className="xr-down">{rub(rp.inTrade.worst.rub)}</b>{rp.inTrade.worst.r != null && <> ({rr(rp.inTrade.worst.r)})</>}
      {rp.riskPerUnit && rp.inTrade.worst.r != null && rp.inTrade.worst.r > -1 && <> — до стопа оставалось {(1 + rp.inTrade.worst.r).toFixed(2).replace('.', ',')}R</>}.</>);
  }
  if (rp.afterExit?.best && rp.actual) {
    const better = (rp.afterExit.best.price - (Number(trade.exitPrice) || 0)) * rp.dir > 0;
    facts.push(better
      ? <>После выхода цена доходила до <b>{px(rp.afterExit.best.price)}</b> ({when(rp.afterExit.best.date)}): держать дальше было бы до <b className="xr-up">{rub(rp.afterExit.best.rub - rp.actual.rub)}</b> лучше — если бы знать, где выйти.</>
      : <>После выхода цена в вашу сторону не пошла — выход не был ранним.</>);
  }
  if (rp.stopHit && rp.exitIdx != null && rp.stopHit.idx > rp.exitIdx) {
    facts.push(<>Если бы держали со стопом, он сработал бы {when(rp.stopHit.date)}{rp.stopHit.gap ? ' с разрывом цены' : ''}: <b className="xr-down">{rub(rp.stopHit.rub)}</b>.</>);
  } else if (rp.stopHit && rp.exitIdx != null && rp.stopHit.idx <= rp.exitIdx) {
    facts.push(<>Цена задевала стоп {when(rp.stopHit.date)}, а сделка оставалась открытой — стоп не стоял у брокера или был сдвинут.</>);
  }

  return (
    <section className="xr-wrap" aria-label="Переигровка выхода">
      <div className="xr-head">
        <h3>Переигровка выхода</h3>
        <span className="xr-sub">Двигайте точку выхода — что было бы, если выйти по закрытию этой свечи{timeframeLabel ? ` (${timeframeLabel})` : ''}</span>
      </div>

      <svg className="xr-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Цена после входа">
        <rect x={x(rp.entryIdx) - bw} y={T} width={Math.max(2, x(holdTo) - x(rp.entryIdx) + bw * 2)} height={H - T - B} className="xr-hold" />
        <line x1={L} x2={W - R} y1={y(rp.entry)} y2={y(rp.entry)} className="xr-entry" />
        {rp.stop > 0 && <line x1={L} x2={W - R} y1={y(rp.stop)} y2={y(rp.stop)} className="xr-stop" />}
        {view.map((c, k) => {
          const i = from + k;
          const up = Number(c.close) >= Number(c.open);
          return (
            <g key={i} className={i < rp.entryIdx ? 'xr-before' : ''}>
              <line x1={x(i)} x2={x(i)} y1={y(Number(c.high))} y2={y(Number(c.low))} className={up ? 'xr-wick-up' : 'xr-wick-down'} />
              <rect x={x(i) - bw / 2} y={y(Math.max(Number(c.open), Number(c.close)))} width={bw}
                height={Math.max(1, Math.abs(y(Number(c.open)) - y(Number(c.close))))} className={up ? 'xr-body-up' : 'xr-body-down'} />
            </g>
          );
        })}
        {rp.inTrade?.best && <circle cx={x(rp.inTrade.best.idx)} cy={y(rp.inTrade.best.price)} r="4" className="xr-dot-best"><title>Лучшая цена в сделке</title></circle>}
        {rp.inTrade?.worst && <circle cx={x(rp.inTrade.worst.idx)} cy={y(rp.inTrade.worst.price)} r="4" className="xr-dot-worst"><title>Худшая цена в сделке</title></circle>}
        {rp.actual && <circle cx={x(rp.exitIdx)} cy={y(rp.actual.price)} r="5" className="xr-dot-exit"><title>Фактический выход</title></circle>}
        <line x1={x(idx)} x2={x(idx)} y1={T} y2={H - B} className="xr-cursor" />
        <circle cx={x(idx)} cy={y(shown.price)} r="5" className={`xr-dot-cursor ${cls(shown.rub ?? shown.pct)}`} />
        <text x={x(rp.entryIdx)} y={H - 6} textAnchor="middle" className="xr-axis">вход</text>
        {rp.exitIdx != null && rp.exitIdx !== rp.entryIdx && <text x={x(rp.exitIdx)} y={H - 6} textAnchor="middle" className="xr-axis">выход</text>}
      </svg>

      <input
        type="range" className="xr-slider" min={rp.entryIdx} max={rp.lastIdx} step="1" value={idx}
        onChange={(e) => setCursor(Number(e.target.value))}
        aria-label="Точка выхода"
      />

      <div className="xr-read">
        <div>
          <span>{isActual ? 'Фактический выход' : `Если выйти ${when(cur.date)}`}</span>
          <b>{px(shown.price)}</b>
        </div>
        <div><span>Результат</span><b className={cls(shown.rub)}>{rub(shown.rub)}</b></div>
        <div><span>В R / в %</span><b className={cls(shown.pct)}>{[rr(shown.r), pct(shown.pct)].filter(Boolean).join(' · ')}</b></div>
        <div>
          <span>Против факта</span>
          <b className={cls(diff)}>{isActual ? 'это факт' : diff == null ? '—' : rub(diff)}</b>
        </div>
      </div>

      <div className="xr-quick">
        {quick.map((q) => <button key={q.id} type="button" className={`xr-btn ${q.active ? 'on' : ''}`} onClick={q.on}>{q.label}</button>)}
      </div>

      {facts.length > 0 && <ul className="xr-facts">{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}

      <p className="xr-note">
        Условно: выход — по цене закрытия свечи, внутри свечи путь цены не виден; стоп — по минимуму/максимуму свечи.
        {rp.kSource === 'spec' ? ' Рубли — по спецификации контракта, приблизительно.' : ' Рубли пересчитаны от фактического результата сделки, с комиссией.'}
        {rp.brokerAdjustment ? ' Факт показан «по ценам» — без фандинга и поправки по марже брокера.' : ''}
        {!rp.riskPerUnit ? ' Стопа у сделки нет — R не считается.' : ''}
      </p>
    </section>
  );
}
