// src/components/backtest/Backtest.js
//
// Admin/trusted-only tool — the "internal instrument" phase agreed with the trader:
// prove the engine's numbers are honest on real history before any client sees a
// backtest result. Runs one of the trader's SAVED strategies (from Капитал) against real
// candle history via runBacktest() (services/backtest/engine.js) — same evaluateStrategy
// the Calculator/Radar/Journal already use, so every new condition added to the
// constructor is backtestable for free, no changes needed here.
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { fetchDailyCandles, TIMEFRAMES, availableTimeframes, DEFAULT_TIMEFRAME, barUnitLabel } from '../../services/marketData/candles';
import { fetchActiveFutureCard, resolveFuturesSpecFromMoex, fetchStockLot } from '../../services/marketData/futuresSpecs';
import { runBacktest } from '../../services/backtest/engine';
import { getStrategies, getActiveStrategy, CONDITION_CATALOG } from '../../services/analytics/strategy';
import { defaultExitRules } from '../../services/analytics/exitRules';
import { backtestPageCache as cache } from '../../services/backtest/pageStateCache';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { calcStats } from '../../services/trades';
import { diagnoseTrades } from '../../services/backtest/tradeDiagnostics';
import { formatNumber } from '../../utils/calculator';
import CandleChart from '../shared/CandleChart';
import ExitRulesEditor from '../shared/ExitRulesEditor';
import NumberInput from '../shared/NumberInput';
import EquityCurve from './EquityCurve';
import TechnicalAnalysisBlock from '../shared/TechnicalAnalysisBlock';
import toast from 'react-hot-toast';

const EXIT_REASON_LABELS = {
  stop: 'Стоп', take: 'Тейк', signal: 'Сигнал пропал', time: 'По времени', end_of_data: 'Конец истории (не закрыта)',
  trail: 'Движение выдохлось',
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

  const [selectedStrategyId, setSelectedStrategyId] = useState(cache.selectedStrategyId ?? activeStrategy?.id);
  const selectedStrategy = strategies.find((s) => s.id === selectedStrategyId) || strategies[0];

  const [ticker, setTicker] = useState(cache.ticker ?? '');
  const [instrumentType, setInstrumentType] = useState(cache.instrumentType ?? 'future');
  const [years, setYears] = useState(cache.years ?? 3);
  // Real trader request 2026-08-12: страница раньше жёстко использовала дневной график
  // (`timeframe: 'D1'` было зашито прямо в вызове fetchDailyCandles) — не было выбора
  // вообще. Идея: тот же следящий выход на более мелком графике держит сделки в разумных
  // календарных рамках вместо недель. H1 бесплатен без токена (MOEX ISS отдаёт его сам),
  // М5/М15 — только с привязанным токеном Т-Инвестиций (см. availableTimeframes).
  const [timeframe, setTimeframe] = useState(cache.timeframe ?? DEFAULT_TIMEFRAME);
  // Local, editable copy of the selected strategy's exit rules — the trader can crank
  // these for a "what if" run right here without touching what's saved in Капитал (real
  // user request: "можно временно крутить"). Resets to the strategy's saved rules
  // whenever a different strategy is picked from the dropdown — but only once per mount
  // (cache restore below shouldn't get immediately overwritten by this same-id effect).
  const [exitRules, setExitRules] = useState(cache.exitRules ?? selectedStrategy?.exitRules ?? defaultExitRules());
  const skipNextExitRulesReset = useRef(cache.exitRules != null);
  useEffect(() => {
    if (skipNextExitRulesReset.current) { skipNextExitRulesReset.current = false; return; }
    setExitRules(selectedStrategy?.exitRules || defaultExitRules());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStrategy?.id]);
  const [maxBarsEnabled, setMaxBarsEnabled] = useState(cache.maxBarsEnabled ?? false);
  // Ticking the checkbox alone must not leave a phantom null behind. The number field
  // shows "20" as a PLACEHOLDER (`value.maxBars ?? 20`) whenever exitRules.maxBars is null
  // — real, common, since defaultExitRules() sets maxBars:null — so the field LOOKS filled
  // in even though the underlying value the run actually reads is still null, and the
  // limit silently never applies unless the trader also retypes the number (real user
  // report: "если ничего не тыкаю... он как будто не считает"). Capital.js's own handler
  // already backfills a real default on check; this page's handler was just the raw
  // setter with no backfill — mirror Capital's fix here.
  const handleMaxBarsEnabledChange = (checked) => {
    setMaxBarsEnabled(checked);
    if (checked) setExitRules((r) => ({ ...r, maxBars: r.maxBars ?? 20 }));
  };
  // Out-of-sample check (real user request, after finding that widening stop/take from
  // 2%/4% to 3%/5% jumped returns from +19% to +59% on one instrument — a huge swing
  // from a tiny tweak, and the classic warning sign of curve-fitting: tuning until a
  // random stretch of history looks good, not finding a real edge). Splits the fetched
  // history into an "тренировочный" slice (tune against freely) and a "отложенный" slice
  // that isn't touched during tuning — only checked once, honestly, at the end.
  const [holdoutEnabled, setHoldoutEnabled] = useState(cache.holdoutEnabled ?? false);
  const [holdoutPct, setHoldoutPct] = useState(cache.holdoutPct ?? 20);

  // Real-risk position sizing (real user request — "мы это в стратегии указываем, зачем
  // придумывать"). Default risk%/margin% come from the strategy's OWN max_risk_percent /
  // max_margin_usage conditions when it has them enabled — those are already the numbers
  // the trader configured, not a separate setting invented for this page. Falls back to
  // the account-wide risk setting (Капитал → Настройки риск-менеджмента), then a plain
  // default, only when the strategy itself doesn't specify one.
  const [realRiskEnabled, setRealRiskEnabled] = useState(cache.realRiskEnabled ?? false);
  const strategyRiskPercent = selectedStrategy?.conditions?.find((c) => c.id === 'max_risk_percent' && c.enabled)?.param;
  const strategyMarginPercent = selectedStrategy?.conditions?.find((c) => c.id === 'max_margin_usage' && c.enabled)?.param;
  const [riskSizing, setRiskSizing] = useState(cache.riskSizing ?? {
    depositSize: userProfile?.depositSize || 100000,
    riskPercent: strategyRiskPercent || userProfile?.maxRiskPerTrade || 1,
    maxMarginPercent: strategyMarginPercent || 30,
    lot: 1, minStep: 1, minStepAmount: 0, initialMargin: 0, commissionRate: 0.0006,
  });
  // Re-derive risk%/margin% from the newly selected strategy — same "reset on strategy
  // switch, but not on cache restore" guard as exitRules above.
  const skipNextRiskSizingReset = useRef(cache.riskSizing != null);
  useEffect(() => {
    if (skipNextRiskSizingReset.current) { skipNextRiskSizingReset.current = false; return; }
    setRiskSizing((r) => ({
      ...r,
      riskPercent: strategyRiskPercent ?? userProfile?.maxRiskPerTrade ?? 1,
      maxMarginPercent: strategyMarginPercent ?? 30,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStrategy?.id]);

  // Auto-fetch real contract specs from MOEX — real user request after finding that
  // leaving "ГО за контракт" at its manual default (0) SILENTLY disables the margin cap
  // for futures entirely (calcTrade's maxContractsByMargin only applies when
  // `iMargin > 0`), so the "Загрузка ГО" field looked configured but did nothing. Reuses
  // the exact same MOEX lookups already used elsewhere in this app (fetchActiveFutureCard
  // for a currently-listed future, resolveFuturesSpecFromMoex as a fallback for an
  // expired series, fetchStockLot for a stock's real lot size) — an explicit button, not
  // automatic-on-every-run, so it never silently overwrites a value the trader typed in
  // by hand on purpose.
  const [specsLoading, setSpecsLoading] = useState(false);
  const fetchSpecs = async () => {
    if (!ticker.trim()) { toast.error('Сначала введи тикер'); return; }
    setSpecsLoading(true);
    try {
      if (instrumentType === 'stock') {
        const lot = await fetchStockLot(ticker.trim().toUpperCase());
        if (lot == null) { toast.error('Не нашёл лот на бирже — введи вручную'); return; }
        setRiskSizing((r) => ({ ...r, lot }));
        toast.success(`Лот: ${lot}`);
      } else {
        let card = await fetchActiveFutureCard(ticker.trim().toUpperCase());
        if (!card) {
          // Expired/inactive series — same fallback Journal already uses, tick size/value
          // is a property of the contract TYPE, not the specific expiry.
          const fallback = await resolveFuturesSpecFromMoex(ticker.trim().toUpperCase());
          if (fallback) card = { ...fallback, initialMargin: null, lot: null };
        }
        if (!card) { toast.error('Не нашёл спецификацию на бирже — введи вручную'); return; }
        // NOT setting `lot` here — real bug, caught live: MOEX's LOTVOLUME for a futures
        // contract describes the underlying asset (e.g. "10 index points per contract"),
        // not a P&L multiplier the way a stock's lot is. calcTrade's futures branch
        // MULTIPLIES lossPerContract by `lot` (same formula as stocks) — feeding
        // LOTVOLUME=10 into it inflated the risk-per-contract 10×, which floored
        // contractsByRisk to 0 on every trade whenever risk% was on the lower end (0.5-1%,
        // like several of the trader's own strategy templates) — "сделки как бы находят,
        // но результат не показывает" was exactly this: every trade silently un-sizeable.
        // For futures, one contract IS the tradeable unit — STEPPRICE already gives the
        // correct ruble value per tick for that one contract, so lot stays at whatever the
        // trader typed (default 1), never auto-filled from LOTVOLUME.
        setRiskSizing((r) => ({
          ...r,
          minStep: card.minPriceIncrement ?? r.minStep,
          minStepAmount: card.minPriceIncrementAmount ?? r.minStepAmount,
          initialMargin: card.initialMargin ?? r.initialMargin,
        }));
        toast.success(
          `Шаг ${card.minPriceIncrement ?? '?'} / ${formatNumber(card.minPriceIncrementAmount ?? 0, 2)}₽`
          + (card.initialMargin ? `, ГО ${formatNumber(card.initialMargin, 0)}₽` : ', ГО не нашёл — введи вручную')
        );
      }
    } finally {
      setSpecsLoading(false);
    }
  };

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // { trades, hadCustomConditions, barsEvaluated, ambiguousBars, candles } — restored from
  // cache so switching to Капитал and back doesn't force a re-run just to see the same
  // numbers again (real user report).
  const [result, setResult] = useState(cache.result ?? null);
  const [holdoutResult, setHoldoutResult] = useState(cache.holdoutResult ?? null); // same shape, out-of-sample slice
  const [holdoutSplitDate, setHoldoutSplitDate] = useState(cache.holdoutSplitDate ?? null);
  const [selectedTradeIdx, setSelectedTradeIdx] = useState(cache.selectedTradeIdx ?? null);

  // Write every field that should survive a route change back into the shared cache
  // object on each render — cheap (plain property assignment, no serialization) since
  // it's a real in-memory object, not JSON/localStorage.
  useEffect(() => {
    Object.assign(cache, {
      selectedStrategyId, ticker, instrumentType, years, timeframe, exitRules, maxBarsEnabled,
      holdoutEnabled, holdoutPct, result, holdoutResult, holdoutSplitDate, selectedTradeIdx,
      realRiskEnabled, riskSizing,
    });
  });

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
        timeframe,
        lookbackDays: Math.round(years * 365),
      });
      if (!candles?.length) throw new Error('Нет исторических свечей по этому тикеру');

      const rules = { ...exitRules, maxBars: maxBarsEnabled ? exitRules.maxBars : null };
      const sizing = realRiskEnabled ? { ...riskSizing, instrumentType } : null;

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
          candles: trainCandles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES[timeframe].minutes, exitRules: rules, riskSizing: sizing,
        });
        const testResult = runBacktest({
          candles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES[timeframe].minutes, exitRules: rules, warmupBars: splitIndex, riskSizing: sizing,
        });
        setResult({ ...trainResult, candles: trainCandles });
        setHoldoutResult({ ...testResult, candles });
        setHoldoutSplitDate(candles[splitIndex]?.date || null);
        if (!trainResult.trades.length && !testResult.trades.length) {
          toast('Ни одной сделки не найдено ни на тренировочном, ни на отложенном периоде', { icon: 'ℹ️' });
        }
      } else {
        const engineResult = runBacktest({
          candles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES[timeframe].minutes, exitRules: rules, riskSizing: sizing,
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

  // Two ways to turn a sequence of closed trades into one equity curve:
  // - % COMPOUNDING (default): start at 100, multiply by (1 + trade%/100) each trade —
  //   the only honest way to combine per-trade % returns into one number when there's no
  //   real position sizing. Explicitly "if you reinvested 100% of the deposit every
  //   single trade" — not a claim about real risk-managed trading.
  // - REAL RISK (opt-in, real user request): sum each trade's real pnlRub (computed by
  //   the engine via the trader's own strategy risk%/margin% — see engine.js's
  //   riskSizing) onto the starting deposit. This is what would actually have happened
  //   trading this strategy with the risk settings already configured in Капитал — the
  //   number the trader can actually compare against real trading. Trades the engine
  //   couldn't size (stop type 'none' — no risk distance to size against) are EXCLUDED
  //   rather than silently falling back to %, which would mix two different units into
  //   one number; `skippedCount` surfaces how many were dropped so this isn't silent.
  function buildEquity(trades) {
    const closed = (trades || []).filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
    if (!realRiskEnabled) {
      let eq = 100;
      const points = [{ x: 0, y: 100 }];
      closed.forEach((t, i) => { eq *= 1 + t.pnlPct / 100; points.push({ x: i + 1, y: eq }); });
      return { points, totalReturnPct: eq - 100, statsTrades: closed, skippedCount: 0 };
    }
    const sized = closed.filter((t) => t.pnlRub != null);
    const skippedCount = closed.length - sized.length;
    let deposit = riskSizing.depositSize;
    const points = [{ x: 0, y: deposit }];
    sized.forEach((t, i) => { deposit += t.pnlRub; points.push({ x: i + 1, y: deposit }); });
    return {
      points, totalReturnPct: ((deposit - riskSizing.depositSize) / riskSizing.depositSize) * 100,
      finalDepositRub: deposit, statsTrades: sized.map((t) => ({ ...t, pnl: t.pnlRub })), skippedCount,
    };
  }

  // Same shape-computation as the main `equity`/`stats` below, reused for the holdout
  // slice so both periods are judged by identical math.
  function computeSummary(res) {
    if (!res) return null;
    const eq = buildEquity(res.trades);
    const st = eq.statsTrades.length ? calcStats(eq.statsTrades) : null;
    return { stats: st, totalReturnPct: eq.totalReturnPct, finalDepositRub: eq.finalDepositRub, skippedCount: eq.skippedCount };
  }

  const equity = useMemo(() => buildEquity(result?.trades),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, realRiskEnabled, riskSizing]);
  const stats = equity.statsTrades?.length ? calcStats(equity.statsTrades) : null;

  // Диагностика по факту закрытия сделок (стоп/тейк/следящий выход/время) — реальный
  // запрос трейдера: не просто показать цифры, а посмотреть на список сделок и
  // подсказать, что стоит попробовать по-другому. Чисто алгоритмические правила (пороги
  // по доле причин закрытия), без ИИ — см. tradeDiagnostics.js.
  const diagnostics = useMemo(() => diagnoseTrades(result?.trades, exitRules),
    [result, exitRules]);

  // Уровни/фигуры для обзорного графика читаются "как сейчас" (на последнюю свечу) —
  // это не то же самое, что видел движок на каждом баре при прогоне (там свой снимок на
  // каждый день, без заглядывания вперёд), а быстрый визуальный чек: похожи ли текущие
  // уровни/фигуры на что-то реальное на глаз.
  const overviewPatterns = useMemo(() => {
    if (!result?.candles?.length) return null;
    const last = result.candles[result.candles.length - 1];
    return computePatternsAtEntry(result.candles, last.date, { timeframeMinutes: TIMEFRAMES[timeframe].minutes });
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
    const patterns = computePatternsAtEntry(result.candles, selectedTrade.entryDate, { timeframeMinutes: TIMEFRAMES[timeframe].minutes });
    const marketContext = computeMarketContextAtEntry(result.candles, selectedTrade.entryDate);
    return { indicators, patterns, marketContext };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTradeIdx, result]);

  // Compact read-only summary of the selected strategy's conditions, shown right on this
  // page — real user report: had to leave for Капитал just to remember what a strategy
  // actually checks, losing whatever was on screen here in the process (now moot thanks
  // to the cache above, but this removes the round-trip entirely for the common case of
  // "what does this strategy even test").
  const strategySummary = useMemo(() => {
    if (!selectedStrategy) return [];
    const catalogById = Object.fromEntries(CONDITION_CATALOG.map((c) => [c.id, c]));
    const dirSuffix = (d) => (d === 'long' ? ' — только лонг' : d === 'short' ? ' — только шорт' : '');
    const lines = (selectedStrategy.conditions || [])
      .filter((c) => c.enabled && catalogById[c.id])
      .map((c) => {
        const def = catalogById[c.id];
        const param = c.param ?? def.defaultParam;
        const label = param != null ? def.label.replace('X', param) : def.label;
        return label + dirSuffix(c.direction);
      });
    const customLines = (selectedStrategy.customConditions || []).map(
      (c) => `${c.label}${dirSuffix(c.direction)} (своё условие — в бэктесте не проверяется)`
    );
    return [...lines, ...customLines];
  }, [selectedStrategy]);

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
        {hasConditions && (
          <details style={{marginBottom:12}}>
            <summary style={{cursor:'pointer', fontSize:12, color:'var(--text-muted)'}}>
              Условия входа ({strategySummary.length}), порог готовности {selectedStrategy.readinessThreshold ?? 60}% — не уходя в Капитал
            </summary>
            <ul style={{margin:'8px 0 0', paddingLeft:18, fontSize:13, color:'var(--text-secondary)'}}>
              {strategySummary.map((line, i) => <li key={i} style={{marginBottom:2}}>{line}</li>)}
            </ul>
          </details>
        )}

        <div className="flex gap-2" style={{marginBottom:12, flexWrap:'wrap'}}>
          <button className={`btn ${instrumentType === 'future' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setInstrumentType('future')}>⚡ Фьючерс</button>
          <button className={`btn ${instrumentType === 'stock' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setInstrumentType('stock')}>📈 Акция</button>
          <input className="input" placeholder="Тикер: IMOEXF, SBER..." value={ticker}
            onChange={(e) => setTicker(e.target.value)} style={{maxWidth:220}} />
          <div className="flex gap-2" style={{alignItems:'center'}}>
            <span style={{fontSize:12, color:'var(--text-muted)'}}>Лет истории</span>
            <NumberInput className="input" min="1" max="20" step="0.5" value={years}
              onChange={(v) => setYears(v)} style={{width:70}} />
          </div>
        </div>

        <div className="flex gap-2" style={{marginBottom:12, flexWrap:'wrap', alignItems:'center'}}>
          <span style={{fontSize:12, color:'var(--text-muted)'}}>Таймфрейм</span>
          {availableTimeframes(!!userProfile?.tinkoffToken).map((tf) => (
            <button key={tf.key} type="button" className={`btn btn-sm ${timeframe === tf.key ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTimeframe(tf.key)}>{tf.label}</button>
          ))}
          {!userProfile?.tinkoffToken && (
            <span style={{fontSize:11, color:'var(--text-muted)'}}>
              М5/М15 — только с привязанным токеном Т-Инвестиций (Настройки)
            </span>
          )}
        </div>
        {timeframe !== 'D1' && (
          <p className="text-xs text-muted" style={{marginTop:-8, marginBottom:12}}>
            На внутридневных графиках история короче, чем на дневном: Ч1 — бесплатно
            через биржу без токена, но не больше пары месяцев вглубь; М5/М15 — только
            с токеном Т-Инвестиций, и там глубина ещё меньше (недели, не месяцы/годы).
            «Лет истории» выше в этом случае не сработает буквально — просто получите
            всё, что реально доступно за этот период.
          </p>
        )}

        <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:8}}>
          Правила выхода — подставлены из выбранной стратегии, можно временно подкрутить для этого прогона (в Капитале не сохранится)
        </div>
        <div style={{marginBottom:16}}>
          <ExitRulesEditor value={exitRules} onChange={setExitRules} maxBarsEnabled={maxBarsEnabled} onMaxBarsEnabledChange={handleMaxBarsEnabledChange} barUnitLabel={barUnitLabel(TIMEFRAMES[timeframe].minutes)} />
        </div>

        <div className="flex gap-2" style={{marginBottom:16, alignItems:'center', flexWrap:'wrap'}}>
          <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer'}}>
            <input type="checkbox" checked={holdoutEnabled} onChange={(e) => setHoldoutEnabled(e.target.checked)} />
            Отложить конец истории для честной проверки (не подглядывать при настройке)
          </label>
          {holdoutEnabled && (
            <>
              <NumberInput className="input" min="5" max="50" step="5" value={holdoutPct}
                onChange={(v) => setHoldoutPct(Math.round(v))} style={{width:70}} />
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

        {/* Real user report: the old checkbox wording ("Реальный риск-менеджмент вместо
            100% реинвестирования") was confusing enough that the trader couldn't tell
            what it actually meant. Two clearly-named buttons instead — same pattern
            already used for Фьючерс/Акция above, not a checkbox with a wall of text. */}
        <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>Как считать доходность</div>
        <div className="flex gap-2" style={{marginBottom:8, flexWrap:'wrap'}}>
          <button type="button" className={`btn ${!realRiskEnabled ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRealRiskEnabled(false)}>
            📊 Теоретический максимум
          </button>
          <button type="button" className={`btn ${realRiskEnabled ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRealRiskEnabled(true)}>
            💰 Реальные деньги (риск + ГО)
          </button>
        </div>
        {!realRiskEnabled && (
          <p className="text-xs text-muted" style={{marginTop:-4, marginBottom:16}}>
            Каждая сделка ставит ВЕСЬ депозит целиком. Не про реальные деньги — просто «сколько можно было бы
            заработать в идеале, если реинвестировать абсолютно всё».
          </p>
        )}
        {realRiskEnabled && (
          <div style={{marginBottom:16, padding:'12px 14px', borderRadius:10, background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)'}}>
            <p className="text-xs text-muted" style={{marginTop:0, marginBottom:10}}>
              Позиция сайзится по твоему реальному риску на сделку и загрузке ГО — как в жизни. Риск%/ГО% подставлены
              из условий «Риск на сделку»/«Загрузка депозита» этой стратегии (если они включены), можно поправить
              только для этого прогона. Нужен реальный стоп (не «Нет») — иначе позицию нечем сайзить. Лот/шаг
              цены/ГО за контракт — введи вручную или подтяни с биржи кнопкой ниже
              (⚠️ пока ГО за контракт = 0, «Загрузка ГО» ничего не ограничивает для фьючерса — считает только по риску).
              Ещё упрощение: ГО берётся СЕГОДНЯШНЕЕ и применяется на всю историю — у биржи оно меняется вместе с
              ценой инструмента, на далёкой истории может быть не совсем точным.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={fetchSpecs} disabled={specsLoading} style={{marginBottom:12}}>
              {specsLoading ? <span className="spinner" style={{width:12,height:12}}/> : '🔄'} Подтянуть с биржи
            </button>
            <div className="flex gap-3" style={{flexWrap:'wrap'}}>
              <div className="input-group" style={{width:130}}>
                <label className="input-label">Депозит, ₽</label>
                <NumberInput className="input" value={riskSizing.depositSize}
                  onChange={(v) => setRiskSizing((r) => ({ ...r, depositSize: v }))} />
              </div>
              <div className="input-group" style={{width:100}}>
                <label className="input-label">Риск, %</label>
                <NumberInput className="input" step="0.1" value={riskSizing.riskPercent}
                  onChange={(v) => setRiskSizing((r) => ({ ...r, riskPercent: v }))} />
              </div>
              <div className="input-group" style={{width:100}}>
                <label className="input-label">Загрузка ГО, %</label>
                <NumberInput className="input" value={riskSizing.maxMarginPercent}
                  onChange={(v) => setRiskSizing((r) => ({ ...r, maxMarginPercent: v }))} />
              </div>
              <div className="input-group" style={{width:90}}>
                <label className="input-label">Лот</label>
                <NumberInput className="input" value={riskSizing.lot}
                  onChange={(v) => setRiskSizing((r) => ({ ...r, lot: v }))} />
              </div>
              <div className="input-group" style={{width:120}}>
                <label className="input-label">Комиссия (0.0006 = 0.06%)</label>
                <NumberInput className="input" step="0.0001" value={riskSizing.commissionRate}
                  onChange={(v) => setRiskSizing((r) => ({ ...r, commissionRate: v }))} />
              </div>
              {instrumentType === 'future' && (
                <>
                  <div className="input-group" style={{width:100}}>
                    <label className="input-label">Шаг цены</label>
                    <NumberInput className="input" value={riskSizing.minStep}
                      onChange={(v) => setRiskSizing((r) => ({ ...r, minStep: v }))} />
                  </div>
                  <div className="input-group" style={{width:120}}>
                    <label className="input-label">Стоим. шага, ₽</label>
                    <NumberInput className="input" value={riskSizing.minStepAmount}
                      onChange={(v) => setRiskSizing((r) => ({ ...r, minStepAmount: v }))} />
                  </div>
                  <div className="input-group" style={{width:100}}>
                    <label className="input-label">ГО, ₽/контр.</label>
                    <NumberInput className="input" value={riskSizing.initialMargin}
                      onChange={(v) => setRiskSizing((r) => ({ ...r, initialMargin: v }))} />
                  </div>
                </>
              )}
            </div>
          </div>
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
            <div className="grid-4" style={{gap:12, marginBottom:8}}>
              <StatCard label="Накопленная доходность" value={`${equity.totalReturnPct >= 0 ? '+' : ''}${formatNumber(equity.totalReturnPct, 1)}%`} tone={equity.totalReturnPct >= 0 ? 'green' : 'red'} />
              {realRiskEnabled && equity.finalDepositRub != null
                ? <StatCard label="Итоговый депозит" value={`${formatNumber(equity.finalDepositRub, 0)} ₽`} tone={equity.totalReturnPct >= 0 ? 'green' : 'red'} />
                : <StatCard label="Сделок" value={stats.total} />}
              <StatCard label="Винрейт" value={`${formatNumber(stats.winrate, 1)}%`} tone={stats.winrate >= 50 ? 'green' : 'red'} />
              <StatCard label="Профит-фактор" value={stats.profitFactor === Infinity ? '∞' : formatNumber(stats.profitFactor, 2)} tone={stats.profitFactor >= 1 ? 'green' : 'red'} />
            </div>
          ) : result.trades?.length > 0 ? (
            // Real bug, caught live: this used to show the SAME "стратегия не набрала
            // нужный %" text as genuinely zero trades, even when the engine found and
            // closed real trades — realRiskEnabled just couldn't SIZE any of them (риск%
            // came out 0/falsy, or contractsByRisk floored to 0 given how tight the risk%
            // is relative to the stop distance). That message was actively false here —
            // the strategy DID trigger, the trades just aren't priced in rubles.
            <div className="card empty-state" style={{marginBottom:16, borderColor:'var(--gold)'}}>
              <div className="empty-state-text">
                Стратегия нашла {result.trades.length} {result.trades.length === 1 ? 'сделку' : 'сделок'}, но ни одну не
                удалось посчитать по реальному риску — проверь риск% (не 0?), стоп (не «Нет»?) и лот/шаг цены/ГО в
                настройках выше. Переключись на «📊 Теоретический максимум», чтобы увидеть сами сделки без сайзинга.
              </div>
            </div>
          ) : (
            <div className="card empty-state" style={{marginBottom:16}}>
              <div className="empty-state-text">Ни одной завершённой сделки за этот период — стратегия ни разу не набрала нужный % готовности.</div>
            </div>
          )}
          {realRiskEnabled && equity.skippedCount > 0 && equity.statsTrades?.length > 0 && (
            <div style={{marginBottom:16, color:'var(--gold)', fontSize:12}}>
              ⚠️ {equity.skippedCount} {equity.skippedCount === 1 ? 'сделка исключена' : 'сделок исключено'} из расчёта реального риска — нет стопа, нечем сайзить позицию по риску (тип выхода «Нет»).
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
                    {realRiskEnabled && h.finalDepositRub != null
                      ? <StatCard label="Итоговый депозит" value={`${formatNumber(h.finalDepositRub, 0)} ₽`} tone={h.totalReturnPct >= 0 ? 'green' : 'red'} />
                      : <StatCard label="Сделок" value={h.stats.total} />}
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

          {diagnostics.length > 0 && (
            <div className="card" style={{marginBottom:16}}>
              <div className="section-title"><div className="section-title-icon">🩺</div>Диагностика сделок</div>
              <p className="text-xs text-muted" style={{marginBottom:12}}>
                Разбор того, ЧЕМ закрывались сделки в этом прогоне (стоп/тейк/время) — не ИИ,
                просто пороговые правила по факту результата. Показывается только когда есть
                на что обратить внимание.
              </p>
              <div className="flex flex-col gap-2">
                {diagnostics.map((d, i) => (
                  <div key={i} style={{
                    padding:'10px 14px', borderRadius:10,
                    background:'rgba(245,158,11,0.08)', border:'1px solid rgba(245,158,11,0.25)',
                  }}>
                    <div style={{fontSize:13, fontWeight:600, marginBottom:4}}>{d.icon} {d.title}</div>
                    <div style={{fontSize:12, color:'var(--text-secondary)', lineHeight:1.5}}>{d.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {equity.points.length > 1 && (
            <div className="card" style={{marginBottom:16}}>
              <div className="section-title"><div className="section-title-icon">📈</div>Кривая капитала</div>
              <p className="text-xs text-muted" style={{marginBottom:8}}>
                {realRiskEnabled
                  ? `Реальные рубли: каждая сделка сайзится по риску ${riskSizing.riskPercent}% от депозита (условие «Риск на сделку» этой стратегии), как если бы ты правда так торговал.`
                  : 'Если бы каждая сделка целиком реинвестировала прошлый результат — не реальный размер позиции, а честный способ свернуть цепочку % в одно число.'}
              </p>
              <EquityCurve points={equity.points} baseline={realRiskEnabled ? riskSizing.depositSize : 100} />
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
                      <th>Выход</th><th>Цена выхода</th><th>Причина</th><th style={{textTransform:'capitalize'}}>{barUnitLabel(TIMEFRAMES[timeframe].minutes)}</th><th>P&L</th>
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
                            <td className={t.pnlPct >= 0 ? 'text-green' : 'text-red'}>
                              {realRiskEnabled && t.pnlRub != null
                                ? `${t.pnlRub >= 0 ? '+' : ''}${formatNumber(t.pnlRub, 0)} ₽`
                                : `${t.pnlPct >= 0 ? '+' : ''}${formatNumber(t.pnlPct, 2)}%`}
                            </td>
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
