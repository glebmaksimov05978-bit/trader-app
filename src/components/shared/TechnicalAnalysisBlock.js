// src/components/shared/TechnicalAnalysisBlock.js
//
// Shared by the Journal (trade "as of entry" frozen snapshot, Radar "as of now" live
// snapshot) and the Calculator's live pre-trade panel — same indicators/patterns shape
// everywhere, only `atDate` and caching strategy differ per caller.
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { formatNumber } from '../../utils/calculator';
import RangeGauge from './RangeGauge';
import Icon from './Icon';
import './TechnicalAnalysisBlock.css';
import { markStrongestLevel, PATTERN_LABELS, STATUS_LABELS, PATTERN_DIRECTIONS } from '../../services/analytics/patterns';
import { useAuth } from '../../context/AuthContext';
import { resolveTaView } from '../../services/analytics/taView';

// Re-exported for existing callers (Calculator.js, Capital.js) that import these from
// here — the definitions themselves moved to patterns.js so strategy.js (a service
// module) could use PATTERN_DIRECTIONS too without depending on a UI component.
export { PATTERN_LABELS, STATUS_LABELS, PATTERN_DIRECTIONS };

// Click-to-reveal explainer for indicator jargon (RSI, %B, Bollinger, ...) — a trader
// asked for exactly this instead of us trying to reword formulas into plain language
// every time: keep the label short, put the "what does this actually mean" text behind
// a small ⓘ. Click toggles (not hover) so it works on touch too.
//
// Rendered into a portal on <body>, positioned with fixed coordinates computed from the
// button's own position — NOT a plain `position: absolute` child. Every modal in this
// app clips overflow (rounded corners need it), and `.modal-body` also computes
// overflow-x to `auto` the moment overflow-y is set — so a simple absolute popup got
// hard-clipped at the modal's edge mid-sentence (real user report/photo: text cut off
// at "...в журна|"). A portal escapes any ancestor's overflow/clipping entirely, which
// is the only fix that's robust regardless of which card or modal an InfoTip ends up in.
export function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const tipRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const TIP_WIDTH = 280;

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - TIP_WIDTH - 12);
      setPos({ top: r.bottom + 6, left: Math.max(12, left) });
    }
    setOpen((o) => !o);
  };

  // Clicking anywhere outside the tooltip (or the button itself) closes it — real user
  // report: only the button's own re-click closed it before, which nobody expects for a
  // popover. The button's own click is left alone (toggle already handles it); this
  // listener only reacts to clicks that land elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (btnRef.current?.contains(e.target) || tipRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <span style={{position:'relative', display:'inline-flex'}}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="Пояснение"
        style={{
          background:'var(--bg-surface-3)', border:'none', borderRadius:'50%', width:14, height:14,
          fontSize:10, lineHeight:'14px', color:'var(--text-muted)', cursor:'pointer', padding:0, flexShrink:0,
        }}
      >ⓘ</button>
      {open && createPortal(
        <span
          ref={tipRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position:'fixed', top:pos.top, left:pos.left, zIndex:10000, width:TIP_WIDTH, fontSize:12, fontWeight:400,
            color:'var(--text-secondary)', background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)',
            borderRadius:10, padding:'10px 12px', boxShadow:'0 8px 24px rgba(0,0,0,0.35)', lineHeight:1.5,
          }}
        >{text}</span>,
        document.body
      )}
    </span>
  );
}

// Color-by-confidence instead of a separate icon system — the number already carries
// the meaning, no need for extra visual clutter next to it (agreed with the trader,
// who found a badge/icon language for "exact vs candidate vs AI" overkill on top of an
// already dense panel).
function confidenceColor(pct) {
  if (pct >= 80) return 'var(--green)';
  if (pct >= 50) return 'var(--gold)';
  return 'var(--red)';
}

// Блок разбит на секции с одинаковым устройством: заголовок-подпись, под ним сетка плиток
// «название — значение». Раньше всё шло сплошным потоком, где подписи и значения лепились
// друг к другу (жалоба: «глаза теряются»). Состав данных и пояснения не менялись.
function Section({ title, tip, hint, children }) {
  return (
    <section className="ta-section">
      <header className="ta-section-head">
        <h4>{title}</h4>
        {tip && <InfoTip text={tip} />}
        {hint && <span className="ta-hint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function Tile({ label, value, tone, sub, tip }) {
  return (
    <div className="ta-tile">
      <div className="ta-tile-label">{label}{tip && <InfoTip text={tip} />}</div>
      <div className={`ta-tile-value ${tone || ''}`}>{value}</div>
      {sub && <div className="ta-tile-sub">{sub}</div>}
    </div>
  );
}

function Chip({ tone, children, strong }) {
  return <span className={`ta-chip ${tone || ''} ${strong ? 'strong' : ''}`}>{children}</span>;
}

// `view` — что показывать (см. services/analytics/taView.js): блоки, подписи порогов стратегии и
// признак «призмы». Не передан — берутся личные настройки из профиля (Настройки → Технический
// анализ). Передаётся явно в окне настроек (живой пример) и в Сопровождении (призма стратегии).
export default function TechnicalAnalysisBlock({ state, onRefresh, title, view: viewProp = null, lensName = null }) {
  let profileView = null;
  const auth = useAuth();
  if (!viewProp) profileView = resolveTaView({ prefs: auth?.userProfile?.taPrefs });
  const view = viewProp || profileView;
  const show = view.visible;
  const note = (id) => (view.lens && view.notes?.[id] ? `стратегия: ${view.notes[id]}` : null);
  return (
    <div className="ta-block">
      <div className="ta-top">
        <div className="ta-title">
          {title}
          {view.lens && <span className="ta-lens"> · по стратегии{lensName ? ` «${lensName}»` : ''}</span>}
        </div>
        {state?.data && !state?.loading && (
          <button className="ta-refresh" onClick={onRefresh} title="Обновить данные">
            <Icon name="refresh" size={13} /> Обновить
          </button>
        )}
      </div>
      {state?.loading && (
        <div className="ta-loading"><div className="spinner" style={{width:14,height:14}} /> Загружаем свечи…</div>
      )}
      {state?.error && (
        <div className="ta-error"><Icon name="warning" size={14} /> {state.error}</div>
      )}
      {state?.data && !state?.loading && view.empty && (
        <div className="ta-note">
          {view.lens
            ? 'У этой стратегии нет рыночных условий — по ним нечего показывать. Включите условия в Капитале.'
            : 'Все блоки выключены. Включите нужные в Настройках → Технический анализ.'}
        </div>
      )}
      {state?.data && !state?.loading && !view.empty && (() => {
        const { indicators, patterns, marketContext } = state.data;
        return (
          <>
            {/* «До SMA200» убрано: дублировало строку EMA200 ниже (оба — расстояние до
                200-периодной средней), и трейдер читал это как одно число дважды. */}
            {(show.rsi || show.macd || show.volume) && (
              <Section title="Индикаторы">
                <div className="ta-grid">
                  {show.rsi && (
                    <Tile label="RSI" value={indicators?.rsi14 != null ? formatNumber(indicators.rsi14, 1) : 'нет данных'} sub={note('rsi')} />
                  )}
                  {show.macd && (
                    <Tile label="MACD" value={indicators?.macdHistogram != null ? formatNumber(indicators.macdHistogram, 2) : 'нет данных'} sub={note('macd')} />
                  )}
                  {show.volume && (
                    <Tile label="Объём"
                      tip="Сравнение объёма сделок в этой свече со средним объёмом за 20 предыдущих свечей того же таймфрейма (на дневном графике — 20 дней, на часовом — 20 часовых баров)."
                      sub={note('volume')}
                      value={indicators?.volumeRatio != null
                        ? (indicators.volumeRatio >= 1
                          ? `в ${formatNumber(indicators.volumeRatio, 1)} раза выше обычного`
                          : `на ${Math.round((1 - indicators.volumeRatio) * 100)}% ниже обычного`)
                        : 'нет данных'} />
                  )}
                </div>
              </Section>
            )}

            {show.context && marketContext && (marketContext.trend || marketContext.volatility) && (
              <Section title="Рыночный контекст" hint={note('context') || 'определяется автоматически'}>
                <div className="ta-grid ta-grid-2">
                  {marketContext.trend && (
                    <div className="ta-gauge">
                      <div className="ta-gauge-line">
                        Тренд: <strong>{marketContext.trend.label === 'up' ? 'восходящий' : marketContext.trend.label === 'down' ? 'нисходящий' : 'боковик'}</strong>
                        <span className="ta-muted"> ({marketContext.trend.slopePct >= 0 ? '+' : ''}{formatNumber(marketContext.trend.slopePct, 1)}%)</span>
                      </div>
                      <RangeGauge percent={marketContext.trend.gaugePercent}
                        leftLabel="Даунтренд" midLabel="Боковик" rightLabel="Аптренд"
                        color={marketContext.trend.label === 'up' ? 'var(--green)' : marketContext.trend.label === 'down' ? 'var(--red)' : 'var(--gold)'} />
                    </div>
                  )}
                  {marketContext.volatility && (
                    <div className="ta-gauge">
                      <div className="ta-gauge-line">
                        Волатильность: <strong>{marketContext.volatility.label === 'high' ? 'выше обычной' : marketContext.volatility.label === 'low' ? 'ниже обычной' : 'обычная'}</strong>
                        <span className="ta-muted"> ({formatNumber(marketContext.volatility.ratio, 2)}× от среднего)</span>
                      </div>
                      <RangeGauge percent={marketContext.volatility.gaugePercent}
                        leftLabel="Низкая" midLabel="Средняя" rightLabel="Высокая"
                        color={marketContext.volatility.label === 'high' ? 'var(--red)' : marketContext.volatility.label === 'low' ? 'var(--blue)' : 'var(--gold)'} />
                    </div>
                  )}
                </div>
              </Section>
            )}

            {show.bollinger && indicators?.bollinger && (
              <Section
                hint={note('bollinger')}
                title={`Полосы Боллинджера — цена ${indicators.bollinger.position === 'above_upper' ? 'выше верхней полосы' : indicators.bollinger.position === 'below_lower' ? 'ниже нижней полосы' : 'внутри полос'}`}
                tip="Коридор обычного разброса цены. Верхняя и нижняя линии — на 2 стандартных отклонения от средней. Цена у верхней границы — рынок разогнан вверх сильнее обычного; у нижней — вниз.">
                <div className="ta-grid">
                  <Tile label="Верхняя" tone="neg" value={formatNumber(indicators.bollinger.upper, 2)} />
                  <Tile label="Средняя" value={formatNumber(indicators.bollinger.mid, 2)} />
                  <Tile label="Нижняя" tone="pos" value={formatNumber(indicators.bollinger.lower, 2)} />
                </div>
              </Section>
            )}

            {patterns && (
              <>
                {show.ema && (
                <Section title="EMA-уровни" hint={note('ema') || 'плавающие поддержка и сопротивление'}>
                  <div className="ta-grid">
                    {[9, 100, 200].map((p) => {
                      const e = patterns.emaLevels?.[`ema${p}`];
                      return (
                        <Tile key={p} label={`EMA${p}`}
                          tone={e ? (e.position === 'above' ? 'pos' : 'neg') : ''}
                          value={e ? `${e.position === 'above' ? 'выше' : 'ниже'} на ${Math.abs(e.distancePct).toFixed(1)}%` : 'нет данных'}
                          sub={e ? (e.slope === 'rising' ? 'наклон: растёт' : e.slope === 'falling' ? 'наклон: падает' : 'наклон: плоская') : null} />
                      );
                    })}
                  </div>
                </Section>
                )}

                {show.levels && patterns.supportResistance?.length > 0 && (() => {
                  // Ranked here, not baked into computePatternsAtEntry — Боллинджер
                  // lives in `indicators`, computed by a separate module, and only the
                  // two are ever available together at this render layer without
                  // threading a new parameter through every caller (Calculator/Journal/
                  // Radar) that calls both compute functions independently.
                  const ranked = markStrongestLevel(patterns.supportResistance, patterns.emaLevels, patterns.fibonacci, indicators?.bollinger);
                  return (
                    <Section title="Уровни поддержки и сопротивления" hint={note('levels') || 'по свингам: красные — цена упиралась сверху, зелёные — отталкивалась снизу'}>
                      <div className="ta-chips">
                        {ranked.map((lvl, i) => (
                          <Chip key={i} tone={lvl.type === 'resistance' ? 'neg' : 'pos'} strong={lvl.isStrongest}>
                            <span className="ta-dot" />
                            {formatNumber(lvl.price, 2)} <span className="ta-muted">· {lvl.touchCount} кас.</span>
                            {lvl.isStrongest && (
                              <span className="ta-star">
                                {lvl.type === 'resistance' ? 'самое сильное сопротивление' : 'самая сильная поддержка'}
                                <InfoTip text={`Почему именно этот уровень сильнее остальных: ${lvl.strengthReasons.join(', ')}. Совпадение с независимым методом расчёта (EMA/Фибоначчи/Боллинджер) весит больше, чем ещё одно касание тем же способом.`} />
                              </span>
                            )}
                          </Chip>
                        ))}
                      </div>
                    </Section>
                  );
                })()}

                {show.fibonacci && patterns.fibonacci && (
                  <Section title="Уровни Фибоначчи" hint={`от ${formatNumber(patterns.fibonacci.from.price, 2)} до ${formatNumber(patterns.fibonacci.to.price, 2)}`}>
                    <div className="ta-chips">
                      {patterns.fibonacci.levels.map((lvl, i) => (
                        <Chip key={i} tone={lvl.isNearest ? 'gold' : ''} strong={lvl.isNearest}>
                          {(lvl.ratio * 100).toFixed(1)}% <span className="ta-muted">·</span> {formatNumber(lvl.price, 2)}{lvl.isNearest ? ' — цена здесь' : ''}
                        </Chip>
                      ))}
                    </div>
                    {!patterns.fibonacci.levels.some(l => l.isNearest) && (
                      <div className="ta-note">Цена сейчас не рядом ни с одним из уровней.</div>
                    )}
                  </Section>
                )}

                {show.patterns && (
                <Section title="Фигуры-кандидаты" hint={note('patterns') || 'алгоритмическая оценка, не мнение AI'}>
                  {patterns.candidates?.length > 0 ? (
                    <div className="ta-list">
                      {patterns.candidates.map((c, i) => (
                        <div key={i} className="ta-row">
                          <div className="ta-row-top">
                            <span className="ta-row-name">{PATTERN_LABELS[c.pattern] || c.pattern}</span>
                            <span className="ta-row-badges">
                              <span className={`badge ${c.status === 'forming' ? 'badge-blue' : c.status === 'invalidated' ? 'badge-red' : 'badge-green'}`}>
                                {STATUS_LABELS[c.status] || c.status}
                              </span>
                              <span className="ta-conf" style={{ color: confidenceColor(c.confidence) }}>~{c.confidence}%</span>
                            </span>
                          </div>
                          <div className="ta-row-detail">{c.detail}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="ta-note">Формальных фигур не найдено.</div>
                  )}
                </Section>
                )}
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}
