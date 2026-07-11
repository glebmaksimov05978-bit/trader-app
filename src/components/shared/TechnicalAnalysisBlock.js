// src/components/shared/TechnicalAnalysisBlock.js
//
// Shared by the Journal (trade "as of entry" frozen snapshot, Radar "as of now" live
// snapshot) and the Calculator's live pre-trade panel — same indicators/patterns shape
// everywhere, only `atDate` and caching strategy differ per caller.
import React from 'react';
import { formatNumber } from '../../utils/calculator';
import RangeGauge from './RangeGauge';

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

export const STATUS_LABELS = { confirmed: 'подтверждена', forming: 'формируется', invalidated: 'отменилась' };

// Color-by-confidence instead of a separate icon system — the number already carries
// the meaning, no need for extra visual clutter next to it (agreed with the trader,
// who found a badge/icon language for "exact vs candidate vs AI" overkill on top of an
// already dense panel).
function confidenceColor(pct) {
  if (pct >= 80) return 'var(--green)';
  if (pct >= 50) return 'var(--gold)';
  return 'var(--red)';
}

// A level (S/R or Fibonacci) with optional "use this price" buttons — only rendered
// when the caller passes onUseAsStop/onUseAsTake, i.e. only in the Calculator, where
// stop/take fields actually exist. Journal and Radar don't pass these, so the buttons
// simply don't appear there. The trader can still always type the number by hand
// afterward — this only prefills, it never locks the field.
function LevelBadge({ price, children, className, onUseAsStop, onUseAsTake }) {
  if (!onUseAsStop && !onUseAsTake) {
    return <span className={className} style={{fontSize:11}}>{children}</span>;
  }
  return (
    <span className={className} style={{fontSize:11, display:'inline-flex', alignItems:'center', gap:4, paddingRight:4}}>
      {children}
      {onUseAsStop && (
        <button onClick={() => onUseAsStop(price)} title="Подставить в стоп-лосс"
          style={{background:'rgba(239,68,68,0.15)', border:'none', borderRadius:5, color:'var(--red)', fontSize:10, padding:'1px 5px', cursor:'pointer', fontFamily:'inherit'}}>
          →SL
        </button>
      )}
      {onUseAsTake && (
        <button onClick={() => onUseAsTake(price)} title="Подставить в тейк-профит"
          style={{background:'rgba(16,185,129,0.15)', border:'none', borderRadius:5, color:'var(--green)', fontSize:10, padding:'1px 5px', cursor:'pointer', fontFamily:'inherit'}}>
          →TP
        </button>
      )}
    </span>
  );
}

export default function TechnicalAnalysisBlock({ state, onRefresh, title, onUseAsStop, onUseAsTake }) {
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
            <div className="grid-4" style={{gap:8, maxWidth:640, marginBottom:14}}>
              <div className="stat-row"><span className="stat-row-label">RSI (14)</span>
                <span className="stat-row-value">{indicators?.rsi14 != null ? formatNumber(indicators.rsi14, 1) : 'нет данных'}</span></div>
              <div className="stat-row"><span className="stat-row-label">MACD гистограмма</span>
                <span className="stat-row-value">{indicators?.macdHistogram != null ? formatNumber(indicators.macdHistogram, 2) : 'нет данных'}</span></div>
              <div className="stat-row"><span className="stat-row-label">До SMA200</span>
                <span className="stat-row-value">{indicators?.sma200Distance != null ? `${indicators.sma200Distance >= 0 ? '+' : ''}${formatNumber(indicators.sma200Distance, 1)}%` : 'нет данных (мало истории)'}</span></div>
              <div className="stat-row"><span className="stat-row-label">Объём к среднему</span>
                <span className="stat-row-value">{indicators?.volumeRatio != null ? `${formatNumber(indicators.volumeRatio, 2)}×` : 'нет данных'}</span></div>
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
                <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>
                  Полосы Боллинджера (20, 2σ) — цена {indicators.bollinger.position === 'above_upper' ? 'выше верхней полосы' : indicators.bollinger.position === 'below_lower' ? 'ниже нижней полосы' : 'внутри полос'} (%B = {formatNumber(indicators.bollinger.percentB, 2)})
                </div>
                <div style={{display:'flex', flexWrap:'wrap', gap:8, marginBottom:14}}>
                  <LevelBadge price={indicators.bollinger.upper} onUseAsStop={onUseAsStop} onUseAsTake={onUseAsTake} className="badge badge-red">
                    ▲ верхняя {formatNumber(indicators.bollinger.upper, 2)}
                  </LevelBadge>
                  <LevelBadge price={indicators.bollinger.mid} onUseAsStop={onUseAsStop} onUseAsTake={onUseAsTake} className="badge">
                    ─ средняя (SMA20) {formatNumber(indicators.bollinger.mid, 2)}
                  </LevelBadge>
                  <LevelBadge price={indicators.bollinger.lower} onUseAsStop={onUseAsStop} onUseAsTake={onUseAsTake} className="badge badge-green">
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
                      <div className="stat-row" key={p}>
                        <span className="stat-row-label">EMA{p}</span>
                        <span className="stat-row-value" style={{color: e ? (e.position === 'above' ? 'var(--green)' : 'var(--red)') : undefined}}>
                          {e ? `${e.position === 'above' ? 'выше' : 'ниже'} на ${Math.abs(e.distancePct).toFixed(1)}% (${e.slope === 'rising' ? '↑' : e.slope === 'falling' ? '↓' : '→'})` : 'нет данных'}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {patterns.supportResistance?.length > 0 && (
                  <>
                    <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>Уровни поддержки/сопротивления (по свингам)</div>
                    <div style={{display:'flex', flexWrap:'wrap', gap:8, marginBottom:14}}>
                      {patterns.supportResistance.map((lvl, i) => (
                        <LevelBadge key={i} price={lvl.price} onUseAsStop={onUseAsStop} onUseAsTake={onUseAsTake}
                          className={`badge ${lvl.type === 'resistance' ? 'badge-red' : 'badge-green'}`}>
                          {lvl.type === 'resistance' ? '▲' : '▼'} {formatNumber(lvl.price, 2)} ({lvl.touchCount} каc.)
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
                        <LevelBadge key={i} price={lvl.price} onUseAsStop={onUseAsStop} onUseAsTake={onUseAsTake}
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
