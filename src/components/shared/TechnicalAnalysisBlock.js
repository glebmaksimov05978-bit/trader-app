// src/components/shared/TechnicalAnalysisBlock.js
//
// Shared by the Journal (trade "as of entry" frozen snapshot, Radar "as of now" live
// snapshot) and the Calculator's live pre-trade panel — same indicators/patterns shape
// everywhere, only `atDate` and caching strategy differ per caller.
import React, { useState } from 'react';
import { formatNumber } from '../../utils/calculator';
import RangeGauge from './RangeGauge';

// Click-to-reveal explainer for indicator jargon (RSI, %B, Bollinger, ...) — a trader
// asked for exactly this instead of us trying to reword formulas into plain language
// every time: keep the label short, put the "what does this actually mean" text behind
// a small ⓘ. Click toggles (not hover) so it works on touch too.
export function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{position:'relative', display:'inline-flex'}}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Пояснение"
        style={{
          background:'var(--bg-surface-3)', border:'none', borderRadius:'50%', width:14, height:14,
          fontSize:10, lineHeight:'14px', color:'var(--text-muted)', cursor:'pointer', padding:0, flexShrink:0,
        }}
      >ⓘ</button>
      {open && (
        <span style={{
          position:'absolute', top:18, left:0, zIndex:10, width:240, fontSize:11, fontWeight:400,
          color:'var(--text-secondary)', background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)',
          borderRadius:8, padding:'8px 10px', boxShadow:'0 4px 12px rgba(0,0,0,0.2)',
        }}>{text}</span>
      )}
    </span>
  );
}

export const PATTERN_LABELS = {
  double_top: 'Двойная вершина',
  double_bottom: 'Двойное дно',
  breakout_up: 'Пробой вверх',
  breakout_down: 'Пробой вниз',
  triangle_symmetric: 'Симметричный треугольник',
  triangle_ascending: 'Восходящий треугольник',
  triangle_descending: 'Нисходящий треугольник',
  wedge_rising: 'Восходящий клин',
  wedge_falling: 'Нисходящий клин',
  flag_ascending: 'Флаг восходящий',
  flag_descending: 'Флаг нисходящий',
  flag_horizontal: 'Флаг горизонтальный',
  pennant_bullish: 'Вымпел (бычий)',
  pennant_bearish: 'Вымпел (медвежий)',
  head_shoulders_top: 'Голова-плечи',
  head_shoulders_bottom: 'Перевёрнутые голова-плечи',
  pin_bar_bullish: 'Пин-бар (бычий)',
  pin_bar_bearish: 'Пин-бар (медвежий)',
  engulfing_bullish: 'Поглощение (бычье)',
  engulfing_bearish: 'Поглощение (медвежье)',
  impulse_up_5wave: '5-волновая структура вверх (упрощённо)',
  impulse_down_5wave: '5-волновая структура вниз (упрощённо)',
};

export const STATUS_LABELS = { confirmed: 'сформирована', forming: 'формируется', invalidated: 'отменилась' };

// Color-by-confidence instead of a separate icon system — the number already carries
// the meaning, no need for extra visual clutter next to it (agreed with the trader,
// who found a badge/icon language for "exact vs candidate vs AI" overkill on top of an
// already dense panel).
function confidenceColor(pct) {
  if (pct >= 80) return 'var(--green)';
  if (pct >= 50) return 'var(--gold)';
  return 'var(--red)';
}

// Label (bold, bright — easy to spot among the surrounding text) then value on the same
// line with a small fixed gap. Not the shared .stat-row's space-between, which in a
// narrow grid cell shoved the value hard against the right edge, away from its label
// (real user report) — but the trader also didn't want the label/value fully stacked
// either, just closer together than the original. This is the middle ground.
function MiniStat({ label, value, tip }) {
  return (
    <div style={{display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap'}}>
      <span style={{fontSize:13, fontWeight:700, color:'var(--text-primary)', display:'inline-flex', alignItems:'center', gap:4, flexShrink:0}}>
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <span style={{fontSize:14, fontWeight:600, color:'var(--text-secondary)'}}>{value}</span>
    </div>
  );
}

// Used to also render →SL/→TP quick-fill buttons in the Calculator — removed (real
// user report: too many small buttons on an already dense panel, hard on the eyes).
// The trader still types stop/take by hand; this level list is read-only everywhere now.
function LevelBadge({ price, children, className }) {
  return <span className={className} style={{fontSize:11}}>{children}</span>;
}

export default function TechnicalAnalysisBlock({ state, onRefresh, title }) {
  return (
    <>
      <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
        <div style={{fontSize:12, color:'var(--text-muted)'}}>{title}</div>
        {state?.data && !state?.loading && (
          <button className="btn btn-ghost btn-sm" style={{fontSize:11, padding:'2px 6px'}} onClick={onRefresh}>🔄 Обновить</button>
        )}
      </div>
      {state?.loading && (
        <div className="flex gap-2" style={{alignItems:'center', color:'var(--text-muted)', fontSize:13}}>
          <div className="spinner" style={{width:14,height:14}}/> Загружаем свечи...
        </div>
      )}
      {state?.error && (
        <div style={{fontSize:13, color:'var(--red)'}}>⚠️ {state.error}</div>
      )}
      {state?.data && !state?.loading && (() => {
        const { indicators, patterns, marketContext } = state.data;
        return (
          <>
            {/* "До SMA200" dropped — it duplicated the EMA200 row below closely enough
                (both "distance to a long-term 200-period average") that the trader read
                them as the same number shown twice, not two different indicators. */}
            <div className="flex flex-col gap-2" style={{maxWidth:420, marginBottom:14}}>
              <MiniStat label="RSI" value={indicators?.rsi14 != null ? formatNumber(indicators.rsi14, 1) : 'нет данных'} />
              <MiniStat label="MACD" value={indicators?.macdHistogram != null ? formatNumber(indicators.macdHistogram, 2) : 'нет данных'} />
              <MiniStat label="Объём"
                tip="Сравнение объёма сделок в этой свече со средним объёмом за 20 предыдущих свечей того же таймфрейма (на дневном графике — 20 дней, на часовом — 20 часовых баров)."
                value={indicators?.volumeRatio != null
                  ? (indicators.volumeRatio >= 1
                    ? `в ${formatNumber(indicators.volumeRatio, 1)} раза выше обычного`
                    : `на ${Math.round((1 - indicators.volumeRatio) * 100)}% ниже обычного`)
                  : 'нет данных'} />
            </div>

            {marketContext && (marketContext.trend || marketContext.volatility) && (
              <>
                <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:8}}>Рыночный контекст (автоопределение)</div>
                <div className="grid-2" style={{gap:16, maxWidth:640, marginBottom:14}}>
                  {marketContext.trend && (
                    <div>
                      <div style={{fontSize:12, marginBottom:4}}>
                        Тренд: <strong>{marketContext.trend.label === 'up' ? 'восходящий' : marketContext.trend.label === 'down' ? 'нисходящий' : 'боковик'}</strong>
                        <span style={{color:'var(--text-muted)'}}> ({marketContext.trend.slopePct >= 0 ? '+' : ''}{formatNumber(marketContext.trend.slopePct, 1)}%)</span>
                      </div>
                      <RangeGauge percent={marketContext.trend.gaugePercent}
                        leftLabel="Даунтренд" midLabel="Боковик" rightLabel="Аптренд"
                        color={marketContext.trend.label === 'up' ? 'var(--green)' : marketContext.trend.label === 'down' ? 'var(--red)' : 'var(--gold)'} />
                    </div>
                  )}
                  {marketContext.volatility && (
                    <div>
                      <div style={{fontSize:12, marginBottom:4}}>
                        Волатильность: <strong>{marketContext.volatility.label === 'high' ? 'выше обычной' : marketContext.volatility.label === 'low' ? 'ниже обычной' : 'обычная'}</strong>
                        <span style={{color:'var(--text-muted)'}}> ({formatNumber(marketContext.volatility.ratio, 2)}× от среднего)</span>
                      </div>
                      <RangeGauge percent={marketContext.volatility.gaugePercent}
                        leftLabel="Низкая" midLabel="Средняя" rightLabel="Высокая"
                        color={marketContext.volatility.label === 'high' ? 'var(--red)' : marketContext.volatility.label === 'low' ? 'var(--blue)' : 'var(--gold)'} />
                    </div>
                  )}
                </div>
              </>
            )}

            {indicators?.bollinger && (
              <>
                <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6, display:'flex', alignItems:'center', gap:6}}>
                  Полосы Боллинджера — цена {indicators.bollinger.position === 'above_upper' ? 'выше верхней полосы' : indicators.bollinger.position === 'below_lower' ? 'ниже нижней полосы' : 'внутри полос'}
                  <InfoTip text="Коридор обычного разброса цены. Верхняя и нижняя линии — на 2 стандартных отклонения от средней. Цена у верхней границы — рынок разогнан вверх сильнее обычного; у нижней — вниз." />
                </div>
                <div style={{display:'flex', flexWrap:'wrap', gap:8, marginBottom:14}}>
                  <LevelBadge price={indicators.bollinger.upper} className="badge badge-red">
                    ▲ верхняя {formatNumber(indicators.bollinger.upper, 2)}
                  </LevelBadge>
                  <LevelBadge price={indicators.bollinger.mid} className="badge">
                    ─ средняя {formatNumber(indicators.bollinger.mid, 2)}
                  </LevelBadge>
                  <LevelBadge price={indicators.bollinger.lower} className="badge badge-green">
                    ▼ нижняя {formatNumber(indicators.bollinger.lower, 2)}
                  </LevelBadge>
                </div>
              </>
            )}

            {patterns && (
              <>
                <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>EMA-уровни (плавающие поддержка/сопротивление)</div>
                <div className="grid-3" style={{gap:8, maxWidth:640, marginBottom:14}}>
                  {[9, 100, 200].map((p) => {
                    const e = patterns.emaLevels?.[`ema${p}`];
                    return (
                      <div key={p}>
                        <div style={{fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:2}}>EMA{p}</div>
                        <div style={{fontSize:13, fontWeight:600, color: e ? (e.position === 'above' ? 'var(--green)' : 'var(--red)') : undefined}}>
                          {/* EMA{p} already named in the label right above — repeating it
                              in the value too was the "текст прилип, больше чем сама
                              надпись" clutter (real user report). */}
                          {e ? `Цена ${e.position === 'above' ? 'выше' : 'ниже'} на ${Math.abs(e.distancePct).toFixed(1)}% (${e.slope === 'rising' ? '↑ растёт' : e.slope === 'falling' ? '↓ падает' : '→ плоская'})` : 'нет данных'}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {patterns.supportResistance?.length > 0 && (
                  <>
                    <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>
                      Уровни поддержки/сопротивления (по свингам) — 🔴 сопротивление (цена упиралась сверху) · 🟢 поддержка (цена отталкивалась снизу)
                    </div>
                    <div style={{display:'flex', flexWrap:'wrap', gap:8, marginBottom:14}}>
                      {patterns.supportResistance.map((lvl, i) => (
                        <LevelBadge key={i} price={lvl.price}
                          className={`badge ${lvl.type === 'resistance' ? 'badge-red' : 'badge-green'}`}>
                          {lvl.type === 'resistance' ? '🔴' : '🟢'} {formatNumber(lvl.price, 2)} ({lvl.touchCount} каc.)
                        </LevelBadge>
                      ))}
                    </div>
                  </>
                )}

                {patterns.fibonacci && (
                  <>
                    <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>
                      Уровни Фибоначчи (от {formatNumber(patterns.fibonacci.from.price, 2)} до {formatNumber(patterns.fibonacci.to.price, 2)})
                    </div>
                    <div style={{display:'flex', flexWrap:'wrap', gap:8, marginBottom:6}}>
                      {patterns.fibonacci.levels.map((lvl, i) => (
                        <LevelBadge key={i} price={lvl.price}
                          className={`badge ${lvl.isNearest ? 'badge-gold' : ''}`}>
                          {(lvl.ratio * 100).toFixed(1)}% — {formatNumber(lvl.price, 2)}{lvl.isNearest ? ' ← цена здесь' : ''}
                        </LevelBadge>
                      ))}
                    </div>
                    {!patterns.fibonacci.levels.some(l => l.isNearest) && (
                      <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:8}}>Цена сейчас не рядом ни с одним из уровней.</div>
                    )}
                  </>
                )}

                <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>Фигуры-кандидаты (алгоритмическая оценка, не мнение AI)</div>
                {patterns.candidates?.length > 0 ? (
                  <div className="flex flex-col gap-2" style={{maxWidth:640}}>
                    {patterns.candidates.map((c, i) => (
                      <div key={i} style={{padding:'8px 12px', background:'var(--bg-surface-3)', borderRadius:10, fontSize:13}}>
                        <div className="flex justify-between items-center">
                          <span style={{fontWeight:600}}>{PATTERN_LABELS[c.pattern] || c.pattern}</span>
                          <div className="flex gap-2" style={{alignItems:'center'}}>
                            <span className={`badge ${c.status === 'forming' ? 'badge-blue' : c.status === 'invalidated' ? 'badge-red' : 'badge-green'}`} style={{fontSize:11}}>
                              {STATUS_LABELS[c.status] || c.status}
                            </span>
                            <span className="badge" style={{fontSize:11, color: confidenceColor(c.confidence), fontWeight:700}}>~{c.confidence}%</span>
                          </div>
                        </div>
                        <div style={{color:'var(--text-muted)', marginTop:2}}>{c.detail}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{fontSize:13, color:'var(--text-muted)'}}>Формальных фигур не найдено.</div>
                )}
              </>
            )}
          </>
        );
      })()}
    </>
  );
}
