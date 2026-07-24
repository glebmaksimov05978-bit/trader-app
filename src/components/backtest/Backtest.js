// src/components/backtest/Backtest.js
//
// Admin/trusted-only tool — the "internal instrument" phase agreed with the trader:
// prove the engine's numbers are honest on real history before any client sees a
// backtest result. Runs one of the trader's SAVED strategies (from Капитал) against real
// candle history via runBacktest() (services/backtest/engine.js) — same evaluateStrategy
// the Calculator/Radar/Journal already use, so every new condition added to the
// constructor is backtestable for free, no changes needed here.
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { fetchDailyCandles, TIMEFRAMES } from '../../services/marketData/candles';
import { runBacktest } from '../../services/backtest/engine';
import { getStrategies, getActiveStrategy } from '../../services/analytics/strategy';
import { defaultExitRules } from '../../services/analytics/exitRules';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { calcStats } from '../../services/trades';
import { formatNumber } from '../../utils/calculator';
import CandleChart from '../shared/CandleChart';
import ExitRulesEditor from '../shared/ExitRulesEditor';
import EquityCurve from './EquityCurve';
import TechnicalAnalysisBlock from '../shared/TechnicalAnalysisBlock';
import toast from 'react-hot-toast';

const EXIT_REASON_LABELS = {
  stop: 'Стоп', take: 'Тейк', signal: 'Сигнал пропал', time: 'По времени', end_of_data: 'Конец истории (не закрыта)',
};

function StatCard({ label, value, tone }) {
  return (
    <div className="card" style={{padding:'12px 16px'}}>
      <div style={{fontSize:11, color:'var(--text-muted)', marginBottom:4}}>{label}</div>
      <div style={{fontSize:20, fontWeight:700, color: tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--text-primary)'}}>{value}</div>
    </div>
  );
}

export default function Backtest() {
  const { userProfile } = useAuth();
  const strategies = getStrategies(userProfile);
  const activeStrategy = getActiveStrategy(userProfile);

  const [selectedStrategyId, setSelectedStrategyId] = useState(activeStrategy?.id);
  const selectedStrategy = strategies.find((s) => s.id === selectedStrategyId) || strategies[0];

  const [ticker, setTicker] = useState('');
  const [instrumentType, setInstrumentType] = useState('future');
  const [years, setYears] = useState(3);
  // Local, editable copy of the selected strategy's exit rules — the trader can crank
  // these for a "what if" run right here without touching what's saved in Капитал (real
  // user request: "можно временно крутить"). Resets to the strategy's saved rules
  // whenever a different strategy is picked from the dropdown.
  const [exitRules, setExitRules] = useState(selectedStrategy?.exitRules || defaultExitRules());
  useEffect(() => {
    setExitRules(selectedStrategy?.exitRules || defaultExitRules());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStrategy?.id]);
  const [maxBarsEnabled, setMaxBarsEnabled] = useState(false);
  // Out-of-sample check (real user request, after finding that widening stop/take from
  // 2%/4% to 3%/5% jumped returns from +19% to +59% on one instrument — a huge swing
  // from a tiny tweak, and the classic warning sign of curve-fitting: tuning until a
  // random stretch of history looks good, not finding a real edge). Splits the fetched
  // history into an "тренировочный" slice (tune against freely) and a "отложенный" slice
  // that isn't touched during tuning — only checked once, honestly, at the end.
  const [holdoutEnabled, setHoldoutEnabled] = useState(false);
  const [holdoutPct, setHoldoutPct] = useState(20);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { trades, hadCustomConditions, barsEvaluated, ambiguousBars, candles }
  const [holdoutResult, setHoldoutResult] = useState(null); // same shape, out-of-sample slice
  const [holdoutSplitDate, setHoldoutSplitDate] = useState(null);
  const [selectedTradeIdx, setSelectedTradeIdx] = useState(null);

  const hasConditions = (selectedStrategy?.conditions?.length || 0) > 0;

  const run = async () => {
    if (!ticker.trim()) { toast.error('Введите тикер'); return; }
    if (!hasConditions) { toast.error('Сначала настройте условия входа в стратегии (вкладка Капитал)'); return; }
    setLoading(true);
    setError(null);
    setResult(null);
    setHoldoutResult(null);
    setHoldoutSplitDate(null);
    setSelectedTradeIdx(null);
    try {
      const candles = await fetchDailyCandles({
        ticker: ticker.trim().toUpperCase(),
        instrumentType,
        toDate: new Date(),
        tinkoffToken: userProfile?.tinkoffToken,
        timeframe: 'D1',
        lookbackDays: Math.round(years * 365),
      });
      if (!candles?.length) throw new Error('Нет исторических свечей по этому тикеру');

      const rules = { ...exitRules, maxBars: maxBarsEnabled ? exitRules.maxBars : null };

      if (holdoutEnabled && candles.length > 60) {
        // Split point: the last `holdoutPct`% of bars is the отложенный кусок. The
        // тренировочный run only ever sees candles BEFORE the split (can't leak future
        // data even by accident). The отложенный run walks the FULL candle array but
        // its `warmupBars` is set to the split index, so indicators/patterns still have
        // real history to compute from (no cold start) while trades can only open AT or
        // AFTER the split — same "no lookahead" contract as the engine already enforces
        // bar-by-bar, just moving where entries are allowed to start.
        const splitIndex = Math.floor(candles.length * (1 - holdoutPct / 100));
        const trainCandles = candles.slice(0, splitIndex);
        const trainResult = runBacktest({
          candles: trainCandles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES.D1.minutes, exitRules: rules,
        });
        const testResult = runBacktest({
          candles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES.D1.minutes, exitRules: rules, warmupBars: splitIndex,
        });
        setResult({ ...trainResult, candles: trainCandles });
        setHoldoutResult({ ...testResult, candles });
        setHoldoutSplitDate(candles[splitIndex]?.date || null);
        if (!trainResult.trades.length && !testResult.trades.length) {
          toast('Ни одной сделки не найдено ни на тренировочном, ни на отложенном периоде', { icon: 'ℹ️' });
        }
      } else {
        const engineResult = runBacktest({
          candles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES.D1.minutes, exitRules: rules,
        });
        setResult({ ...engineResult, candles });
        if (!engineResult.trades.length) {
          toast('Ни одной сделки не найдено — стратегия ни разу не набрала нужный % за этот период', { icon: 'ℹ️' });
        }
      }
    } catch (e) {
      setError(e.message || 'Не удалось запустить бэктест');
    } finally {
      setLoading(false);
    }
  };

  // Same shape-computation as the main `equity`/`stats` below, reused for the holdout
  // slice so both periods are judged by identical math — see the comment on `equity`.
  function computeSummary(res) {
    if (!res) return null;
    const st = res.trades?.length ? calcStats(res.trades) : null;
    const closed = (res.trades || []).filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
    let eq = 100;
    closed.forEach((t) => { eq *= 1 + t.pnlPct / 100; });
    return { stats: st, totalReturnPct: eq - 100 };
  }

  const stats = result?.trades?.length ? calcStats(result.trades) : null;

  // Compounded equity curve — start at 100, multiply by (1 + trade%/100) for every
  // CLOSED trade in chronological order. This is the only honest way to combine a
  // sequence of per-trade % returns into one number when v1 has no real position sizing
  // (see engine.js) — explicitly a "if you reinvested everything every time" simplification,
  // not a claim about real risk-managed compounding, and labeled as such below.
  const equity = useMemo(() => {
    const closed = (result?.trades || []).filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
    let eq = 100;
    const points = [{ x: 0, y: 100 }];
    closed.forEach((t, i) => { eq *= 1 + t.pnlPct / 100; points.push({ x: i + 1, y: eq }); });
    return { points, totalReturnPct: eq - 100 };
  }, [result]);

  // Уровни/фигуры для обзорного графика читаются "как сейчас" (на последнюю свечу) —
  // это не то же самое, что видел движок на каждом баре при прогоне (там свой снимок на
  // каждый день, без заглядывания вперёд), а быстрый визуальный чек: похожи ли текущие
  // уровни/фигуры на что-то реальное на глаз.
  const overviewPatterns = useMemo(() => {
    if (!result?.candles?.length) return null;
    const last = result.candles[result.candles.length - 1];
    return computePatternsAtEntry(result.candles, last.date, { timeframeMinutes: TIMEFRAMES.D1.minutes });
  }, [result]);

  const selectedTrade = selectedTradeIdx != null ? result?.trades?.[selectedTradeIdx] : null;

  // Exactly what the engine itself saw on the bar it decided to enter — same functions,
  // same `entryDate`, no lookahead. This is the whole point of the drill-down (real user
  // request): the arrow on the overview chart says "entered here", this says WHY —
  // RSI/MACD/Bollinger numbers, the full list of support/resistance levels with touch
  // counts, and the pattern candidates with their confidence — so the trader can compare
  // what the algorithm claims against what they see with their own eyes, not just trust
  // a green arrow.
  const selectedTradeSnapshot = useMemo(() => {
    if (!selectedTrade || !result?.candles?.length) return null;
    const indicators = computeIndicatorsAtEntry(result.candles, selectedTrade.entryDate);
    const patterns = computePatternsAtEntry(result.candles, selectedTrade.entryDate, { timeframeMinutes: TIMEFRAMES.D1.minutes });
    const marketContext = computeMarketContextAtEntry(result.candles, selectedTrade.entryDate);
    return { indicators, patterns, marketContext };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTradeIdx, result]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">🧪 Бэктест (внутренний инструмент)</h1>
          <p className="page-subtitle">
            Прогон сохранённой стратегии по реальной истории. Видно только тебе — цифры ещё калибруются, для клиентов пока не показываем.
          </p>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div className="section-title"><div className="section-title-icon">⚙️</div>Параметры прогона</div>

        <div className="input-group" style={{maxWidth:320, marginBottom:12}}>
          <label className="input-label">Стратегия</label>
          <select className="input" value={selectedStrategyId} onChange={(e) => setSelectedStrategyId(e.target.value)}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.id === activeStrategy?.id ? ' (активная)' : ''}</option>
            ))}
          </select>
        </div>

        {!hasConditions && (
          <div style={{marginBottom:12, color:'var(--gold)', fontSize:13}}>
            ⚠️ У этой стратегии нет ни одного включённого условия входа — настрой её в «Капитале».
          </div>
        )}

        <div className="flex gap-2" style={{marginBottom:12, flexWrap:'wrap'}}>
          <button className={`btn ${instrumentType === 'future' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setInstrumentType('future')}>⚡ Фьючерс</button>
          <button className={`btn ${instrumentType === 'stock' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setInstrumentType('stock')}>📈 Акция</button>
          <input className="input" placeholder="Тикер: IMOEXF, SBER..." value={ticker}
            onChange={(e) => setTicker(e.target.value)} style={{maxWidth:220}} />
          <div className="flex gap-2" style={{alignItems:'center'}}>
            <span style={{fontSize:12, color:'var(--text-muted)'}}>Лет истории</span>
            <input className="input" type="number" min="1" max="20" step="0.5" value={years}
              onChange={(e) => setYears(parseFloat(e.target.value) || 1)} style={{width:70}} />
          </div>
        </div>

        <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:8}}>
          Правила выхода — подставлены из выбранной стратегии, можно временно подкрутить для этого прогона (в Капитале не сохранится)
        </div>
        <div style={{marginBottom:16}}>
          <ExitRulesEditor value={exitRules} onChange={setExitRules} maxBarsEnabled={maxBarsEnabled} onMaxBarsEnabledChange={setMaxBarsEnabled} />
        </div>

        <div className="flex gap-2" style={{marginBottom:16, alignItems:'center', flexWrap:'wrap'}}>
          <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer'}}>
            <input type="checkbox" checked={holdoutEnabled} onChange={(e) => setHoldoutEnabled(e.target.checked)} />
            Отложить конец истории для честной проверки (не подглядывать при настройке)
          </label>
          {holdoutEnabled && (
            <>
              <input className="input" type="number" min="5" max="50" step="5" value={holdoutPct}
                onChange={(e) => setHoldoutPct(parseInt(e.target.value) || 20)} style={{width:70}} />
              <span style={{fontSize:12, color:'var(--text-muted)'}}>% истории — отложенный кусок в конце</span>
            </>
          )}
        </div>
        {holdoutEnabled && (
          <p className="text-xs text-muted" style={{marginTop:-10, marginBottom:16}}>
            Крути параметры сколько угодно, глядя только на «Тренировочный период» ниже. «Отложенный период» смотри
            в последнюю очередь и только один раз — если стратегия там тоже в плюсе, доверия к ней сильно больше.
          </p>
        )}

        <button className="btn btn-primary" onClick={run} disabled={loading}>
          {loading ? <span className="spinner" style={{width:14,height:14}}/> : '▶️'} Запустить бэктест
        </button>
        {error && <div style={{color:'var(--red)', marginTop:10, fontSize:13}}>⚠️ {error}</div>}
      </div>

      {result && (
        <>
          {result.hadCustomConditions && (
            <div className="card" style={{marginBottom:16, borderColor:'var(--gold)'}}>
              <div style={{color:'var(--gold)', fontSize:13}}>
                ⚠️ В стратегии есть «свои условия» (ручные галочки) — бэктест их пропустил: их некому отметить механически. Результат посчитан только по условиям из каталога.
              </div>
            </div>
          )}
          {result.ambiguousBars > 0 && (
            <div className="card" style={{marginBottom:16, borderColor:'var(--gold)'}}>
              <div style={{color:'var(--gold)', fontSize:13}}>
                ⚠️ На {result.ambiguousBars} {result.ambiguousBars === 1 ? 'дне' : 'днях'} условия одновременно набрали нужный % и для лонга, и для шорта — бэктест выбрал сторону с более высоким %. Признак того, что часть условий стратегии не привязана к направлению.
              </div>
            </div>
          )}

          {holdoutResult && (
            <div style={{fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:8}}>
              📗 Тренировочный период {holdoutSplitDate ? `(до ${holdoutSplitDate.toLocaleDateString('ru-RU')})` : ''} — на нём можно крутить параметры
            </div>
          )}
          {stats ? (
            <div className="grid-4" style={{gap:12, marginBottom:16}}>
              <StatCard label="Накопленная доходность" value={`${equity.totalReturnPct >= 0 ? '+' : ''}${formatNumber(equity.totalReturnPct, 1)}%`} tone={equity.totalReturnPct >= 0 ? 'green' : 'red'} />
              <StatCard label="Сделок" value={stats.total} />
              <StatCard label="Винрейт" value={`${formatNumber(stats.winrate, 1)}%`} tone={stats.winrate >= 50 ? 'green' : 'red'} />
              <StatCard label="Профит-фактор" value={stats.profitFactor === Infinity ? '∞' : formatNumber(stats.profitFactor, 2)} tone={stats.profitFactor >= 1 ? 'green' : 'red'} />
            </div>
          ) : (
            <div className="card empty-state" style={{marginBottom:16}}>
              <div className="empty-state-text">Ни одной завершённой сделки за этот период — стратегия ни разу не набрала нужный % готовности.</div>
            </div>
          )}

          {holdoutResult && (() => {
            const h = computeSummary(holdoutResult);
            return (
              <>
                <div style={{fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:8, display:'flex', alignItems:'center', gap:8}}>
                  📕 Отложенный период {holdoutSplitDate ? `(с ${holdoutSplitDate.toLocaleDateString('ru-RU')})` : ''} — стратегия эти данные не видела при настройке
                </div>
                {h.stats ? (
                  <div className="grid-4" style={{gap:12, marginBottom:16}}>
                    <StatCard label="Накопленная доходность" value={`${h.totalReturnPct >= 0 ? '+' : ''}${formatNumber(h.totalReturnPct, 1)}%`} tone={h.totalReturnPct >= 0 ? 'green' : 'red'} />
                    <StatCard label="Сделок" value={h.stats.total} />
                    <StatCard label="Винрейт" value={`${formatNumber(h.stats.winrate, 1)}%`} tone={h.stats.winrate >= 50 ? 'green' : 'red'} />
                    <StatCard label="Профит-фактор" value={h.stats.profitFactor === Infinity ? '∞' : formatNumber(h.stats.profitFactor, 2)} tone={h.stats.profitFactor >= 1 ? 'green' : 'red'} />
                  </div>
                ) : (
                  <div className="card empty-state" style={{marginBottom:16}}>
                    <div className="empty-state-text">Ни одной сделки на отложенном периоде — слишком короткий кусок или стратегия там ни разу не сработала.</div>
                  </div>
                )}
                {stats && h.stats && (
                  <div className="card" style={{marginBottom:16, borderColor: (h.totalReturnPct >= 0) === (equity.totalReturnPct >= 0) ? 'var(--green)' : 'var(--red)'}}>
                    <div style={{fontSize:13}}>
                      {h.totalReturnPct >= 0 && equity.totalReturnPct >= 0
                        ? '✅ Плюс на обоих периодах — хороший знак, стратегия не развалилась на данных, которые не участвовали в настройке.'
                        : h.totalReturnPct < 0 && equity.totalReturnPct >= 0
                        ? '⚠️ На тренировочном плюс, на отложенном минус — характерный признак подгонки под конкретный отрезок истории, не настоящего преимущества.'
                        : 'Оба периода в минусе — стратегия последовательно не работает, это тоже честный и полезный результат.'}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {equity.points.length > 1 && (
            <div className="card" style={{marginBottom:16}}>
              <div className="section-title"><div className="section-title-icon">📈</div>Кривая капитала</div>
              <p className="text-xs text-muted" style={{marginBottom:8}}>
                Если бы каждая сделка целиком реинвестировала прошлый результат — не реальный размер позиции
                (в v1 его ещё нет), а честный способ свернуть цепочку % в одно число.
              </p>
              <EquityCurve points={equity.points} />
            </div>
          )}

          {result.trades?.length > 0 && (
            <div className="card" style={{marginBottom:16}}>
              <div className="section-title"><div className="section-title-icon">📊</div>График сделок</div>
              <p className="text-xs text-muted" style={{marginBottom:8}}>
                Все сделки прогона сразу на графике — ▲/▼ вход, ● выход. Слои S/R/EMA/Боллинджер/RSI/MACD
                считаются НА ПОСЛЕДНЮЮ свечу (как сейчас), не пересчитываются на каждый день прогона — это
                визуальная проверка «похоже ли на правду», не то, что видел движок в момент каждой сделки.
              </p>
              <CandleChart
                candles={result.candles}
                patterns={overviewPatterns}
                ticker={ticker.toUpperCase()}
                trades={result.trades}
              />
            </div>
          )}

          {result.trades?.length > 0 && (
            <div className="card">
              <div className="section-title"><div className="section-title-icon">📋</div>Сделки ({result.trades.length})</div>
              <p className="text-xs text-muted" style={{marginBottom:8}}>Клик по строке — что именно алгоритм увидел на момент входа этой сделки.</p>
              <div style={{overflowX:'auto'}}>
                <table className="table" style={{fontSize:13}}>
                  <thead>
                    <tr>
                      <th>Направление</th><th>Вход</th><th>Цена входа</th><th>% готовности</th>
                      <th>Выход</th><th>Цена выхода</th><th>Причина</th><th>Дней</th><th>P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => {
                      const isSelected = selectedTradeIdx === i;
                      return (
                        <React.Fragment key={i}>
                          <tr onClick={() => setSelectedTradeIdx(isSelected ? null : i)}
                            style={{cursor:'pointer', background: isSelected ? 'var(--bg-surface-3)' : undefined}}>
                            <td>
                              <div className="flex gap-2" style={{alignItems:'center'}}>
                                <span style={{fontSize:11, color:'var(--text-muted)', width:12, display:'inline-block'}}>{isSelected ? '▾' : '▸'}</span>
                                <span className={`badge ${t.direction === 'long' ? 'badge-green' : 'badge-red'}`}>{t.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}</span>
                              </div>
                            </td>
                            <td className="text-secondary">{t.entryDate.toLocaleDateString('ru-RU')}</td>
                            <td>{formatNumber(t.entryPrice, 2)}</td>
                            <td className="text-secondary">{formatNumber(t.entryPercent, 0)}%</td>
                            <td className="text-secondary">{t.exitDate.toLocaleDateString('ru-RU')}</td>
                            <td>{formatNumber(t.exitPrice, 2)}</td>
                            <td>{t.status === 'open' ? <span className="badge badge-blue">Ещё открыта</span> : EXIT_REASON_LABELS[t.exitReason] || t.exitReason}</td>
                            <td className="text-secondary">{t.barsHeld}</td>
                            <td className={t.pnlPct >= 0 ? 'text-green' : 'text-red'}>{t.pnlPct >= 0 ? '+' : ''}{formatNumber(t.pnlPct, 2)}%</td>
                          </tr>
                          {isSelected && selectedTradeSnapshot && (
                            <tr>
                              <td colSpan={9} style={{background:'var(--bg-surface-2)', padding:'12px 16px 16px'}}>
                                <div className="section-title" style={{marginBottom:12}}>
                                  <div className="section-title-icon">🔍</div>
                                  Что видел алгоритм на момент входа {t.entryDate.toLocaleDateString('ru-RU')}
                                </div>
                                <div style={{marginBottom:16}}>
                                  <CandleChart
                                    candles={result.candles}
                                    patterns={selectedTradeSnapshot.patterns}
                                    ticker={ticker.toUpperCase()}
                                    direction={t.direction}
                                    entryPrice={t.entryPrice}
                                    exitPrice={t.status === 'closed' ? t.exitPrice : null}
                                    entryMarker={{ date: t.entryDate, price: t.entryPrice, direction: t.direction }}
                                    exitMarker={{ date: t.exitDate, price: t.exitPrice }}
                                  />
                                </div>
                                <TechnicalAnalysisBlock
                                  state={{ loading: false, error: null, data: selectedTradeSnapshot }}
                                  title="Технический анализ на момент входа этой сделки"
                                />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
