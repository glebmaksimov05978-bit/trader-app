// src/components/cockpit/Cockpit.js
//
// «Сопровождение» — третья фаза сделки, которой в приложении не было. Калькулятор
// отвечает на вопрос «стоит ли заходить», Журнал — «что получилось», а эта вкладка
// показывает открытую позицию изнутри прямо сейчас.
//
// Ключевое правило: здесь НЕ считаются ни правила выхода, ни деньги. Состояние сделки
// приходит из движка бэктеста (computeBothLines → engine.js), цифры позиции — из тех же
// полей журнала, что показывает Журнал. Иначе панель и бэктест начнут расходиться, и
// доверять будет нечему.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, resolveOpenedAt } from '../../services/trades';
import { fetchDailyCandles, availableTimeframes } from '../../services/marketData/candles';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { getActiveStrategy, getStrategies } from '../../services/analytics/strategy';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';
import { commissionRateFor, DEFAULT_TARIFF } from '../../services/analytics/commission';
import { computeBothLines } from '../../services/backtest/livePosition';
import { computeProfitBreakdown, computeLossBreakdown } from '../../services/backtest/engine';
import { evaluateAlerts, DEFAULT_ALERT_PREFS } from '../../services/alerts';
import { loadBacktestSample, findSimilar, probabilityOfGoal } from '../../services/backtest/similarTrades';
import CandleChart from '../shared/CandleChart';
import RadarPanel from './RadarPanel';
import CollapsibleSection from './CollapsibleSection';
import './Cockpit.css';

const fmtPct = (v, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const fmtRub = (v) => (v == null ? '—'
  : `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v)).toLocaleString('ru-RU')} ₽`);
const fmtNum = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

// Индекс бара, ближайшего к дате и не позже неё. Тот же приём, что в Журнале при
// восстановлении картины «на момент входа».
function indexAtOrBefore(candles, date) {
  if (!date) return -1;
  const t = new Date(date).getTime();
  let found = -1;
  for (let i = 0; i < candles.length; i++) {
    if (new Date(candles[i].date).getTime() <= t) found = i; else break;
  }
  return found;
}

function ScorePanel({ title, hint, score, threshold, max, breakdown, reached, tone }) {
  const pct = Math.max(0, Math.min(100, ((score ?? 0) / max) * 100));
  return (
    <div className="ck-panel ck-score">
      <div className="ck-score-head">
        <div>
          <h3>{title}</h3>
          <div className="ck-hint">{hint}</div>
        </div>
        <div className={`ck-score-num ${reached ? tone : ''}`}>
          {score ?? '—'}<small>/{threshold}</small>
        </div>
      </div>
      <div className="ck-gauge">
        <i style={{ width: `${pct}%` }} className={reached ? tone : ''} />
        <span className="ck-th" style={{ left: `${(threshold / max) * 100}%` }} />
        <span className="ck-th-label" style={{ left: `${(threshold / max) * 100}%` }}>порог {threshold}</span>
      </div>
      <div className="ck-comps">
        {(breakdown || []).map((c) => (
          <div key={c.key} className={`ck-comp ${c.on ? 'on' : ''} ${c.penalty ? 'pen' : ''}`}>
            <span className="ck-flag">{c.on ? (c.penalty ? '−1' : '✓') : ''}</span>
            <span className="ck-comp-label">{c.label}</span>
            <span className="ck-comp-detail">{c.detail}</span>
          </div>
        ))}
        {!breakdown?.length && <div className="ck-empty">Пока нечего показать</div>}
      </div>
    </div>
  );
}

// Место панели, которой у этой стратегии нет. Пустое место или ноль на шкале читались бы
// как «система молчит», а она просто не включена — это разные вещи.
function SystemOff({ title, text }) {
  return (
    <div className="ck-panel ck-score ck-score-off">
      <div className="ck-score-head">
        <div>
          <h3>{title}</h3>
          <div className="ck-hint">не используется вашей стратегией</div>
        </div>
      </div>
      <div className="ck-off-text">{text}</div>
      <Link className="ck-btn" to="/capital">Настроить правила выхода</Link>
    </div>
  );
}

export default function Cockpit() {
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const [trades, setTrades] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState(null);      // { actual, shadow, deltaPct }
  const [candles, setCandles] = useState(null);
  const [patterns, setPatterns] = useState(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState(null);
  const [showMe, setShowMe] = useState(true);
  const [showSys, setShowSys] = useState(true);
  const [closeShare, setCloseShare] = useState(100);
  const [tfOverride, setTfOverride] = useState(null);
  const [sample, setSample] = useState(null);
  const [goal, setGoal] = useState(5);

  useEffect(() => { loadBacktestSample().then(setSample); }, []);

  // Вкладка может работать по любой из сохранённых стратегий — выбор здесь меняет
  // ПРАВИЛА, по которым вкладка ведёт позицию (профит-/лосс-система живут в exitRules
  // стратегии). По умолчанию берём активную из настроек, дальше трейдер переключает
  // сам. Сама сделка при этом помнит стратегию, по которой была открыта, — если она
  // другая, вкладка честно об этом пишет, а не подменяет молча.
  const strategies = useMemo(() => getStrategies(userProfile), [userProfile]);
  const [strategyId, setStrategyId] = useState(null);
  const strategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) || getActiveStrategy(userProfile),
    [strategies, strategyId, userProfile],
  );
  // Через useMemo, а не инлайном: у стратегии без правил выражение `|| {}` создавало НОВЫЙ
  // объект на каждый рендер, а от него зависит recompute → эффект перезапускался бесконечно
  // и вкладка молотила запросы свечей по кругу.
  const exitRules = useMemo(() => strategy?.exitRules || {}, [strategy]);
  // Какими системами выхода стратегия реально пользуется. От этого зависит, что вкладке
  // осмысленно показывать: у стратегии без частичных фиксаций «когорта фиксаций» и счёт
  // профит-системы — числа без применения.
  const usesProfitSystem = !!exitRules.profitCaptureEnabled;
  const usesLossSystem = exitRules.trailLossRule === 'score';
  // Без включённого трейлинга движок в этой вкладке не делает ВООБЩЕ ничего: он не следит
  // за пиком, не взводит счёт и не предлагает фиксаций — все панели показывают прочерки, и
  // выглядит это как «переключил стратегию, а ничего не пересчиталось» (реальная жалоба).
  // Молчать об этом нельзя: пустая панель и «правила выключены» — разные вещи.
  const noExitRules = !exitRules.trailEnabled && !usesProfitSystem && !usesLossSystem;

  // --- открытые позиции ---
  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      try {
        const all = await getUserTrades(user.uid);
        const open = all.filter((t) => t.status === 'open' || t.status === 'partial');
        setTrades(open);
        setActiveId((cur) => cur || open[0]?.id || null);
      } catch (e) {
        toast.error('Не удалось загрузить сделки');
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const trade = useMemo(() => trades.find((t) => t.id === activeId) || null, [trades, activeId]);
  const timeframe = tfOverride || trade?.entryTimeframe || userProfile?.preferredTimeframe || 'H1';

  // --- состояние позиции по данным движка ---
  const recompute = useCallback(async () => {
    if (!trade) { setState(null); setCandles(null); return; }
    setComputing(true);
    setError(null);
    try {
      const cs = await fetchDailyCandles({
        ticker: trade.ticker,
        instrumentType: trade.instrumentType || 'stock',
        toDate: new Date(),
        timeframe,
        tinkoffToken: userProfile?.tinkoffToken,
      });
      if (!cs?.length) throw new Error('Нет свечей по этому инструменту');
      setCandles(cs);
      setPatterns(computePatternsAtEntry(cs, new Date()));

      const openedAt = resolveOpenedAt(trade);
      const entryIndex = indexAtOrBefore(cs, openedAt);
      if (entryIndex < 1) throw new Error('Дата входа вне загруженной истории — увеличьте период');

      const volume = parseFloat(trade.volume) || 1;
      const actualFills = (trade.legs || [])
        .filter((l) => l.type === 'close')
        .map((l) => ({
          index: Math.max(entryIndex + 1, indexAtOrBefore(cs, l.timestampUtc)),
          fraction: (parseFloat(l.quantity) || 0) / volume,
          price: parseFloat(l.price),
          timestampUtc: l.timestampUtc,
        }))
        .filter((f) => f.fraction > 0);

      const res = computeBothLines({
        candles: cs,
        entryIndex,
        direction: trade.direction === 'short' ? 'short' : 'long',
        entryPrice: parseFloat(trade.entryPrice),
        rules: exitRules,
        stopPrice: trade.stopLoss ? parseFloat(trade.stopLoss) : null,
        takePrice: trade.takeProfit ? parseFloat(trade.takeProfit) : null,
        actualFills,
      });
      setState({ ...res, entryIndex, actualFills });
    } catch (e) {
      setError(e.message || 'Не удалось посчитать состояние позиции');
      setState(null);
    } finally {
      setComputing(false);
    }
  }, [trade, timeframe, exitRules, userProfile?.tinkoffToken]);

  useEffect(() => { recompute(); }, [recompute]);

  // --- разбор по признакам на текущем баре ---
  const breakdowns = useMemo(() => {
    if (!state?.actual?.position || !candles?.length) return { profit: null, loss: null };
    const pos = state.actual.position;
    const i = candles.length - 1;
    const bar = candles[i];
    const ret = pos.direction === 'long'
      ? ((bar.close - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - bar.close) / pos.entryPrice) * 100;
    try {
      return {
        profit: computeProfitBreakdown(pos, bar, candles, i, ret),
        loss: computeLossBreakdown(pos, bar, candles, i, ret),
      };
    } catch { return { profit: null, loss: null }; }
  }, [state, candles]);

  const alerts = useMemo(() => {
    if (!state?.actual || !trade) return [];
    return evaluateAlerts(state.actual, trade, {
      ...DEFAULT_ALERT_PREFS, ...(userProfile?.alertPrefs || {}),
    });
  }, [state, trade, userProfile]);

  // --- деньги: те же поля, что использует Журнал ---
  const money = useMemo(() => {
    if (!state?.actual || !trade || !candles?.length) return null;
    const a = state.actual;
    const price = candles[candles.length - 1].close;
    const volume = parseFloat(trade.volume) || 1;
    const lot = parseFloat(trade.lot) || 1;
    const step = parseFloat(trade.minStep) || 0;
    const stepAmount = parseFloat(trade.minStepAmount) || 0;
    // У сделки обычно уже есть своя ставка (сохранена при открытии) — используем её,
    // как и Журнал при закрытии. Запасной вариант — тариф из Настроек, а не выдуманное
    // 0.0006, которое не совпадает ни с одним реальным тарифом Т-Банка.
    const commRate = parseFloat(trade.commissionRate)
      || commissionRateFor(userProfile?.brokerTariff || DEFAULT_TARIFF, trade.instrumentType || 'stock').rate;
    const entry = parseFloat(trade.entryPrice);
    const dir = trade.direction === 'short' ? -1 : 1;

    const remainingVol = (parseFloat(trade.remainingVolume ?? trade.volume) || 0);
    const closingVol = remainingVol * (closeShare / 100);
    const perUnit = step && stepAmount
      ? ((price - entry) / step) * stepAmount * dir
      : (price - entry) * dir;
    const gross = perUnit * closingVol * lot;
    const commission = entry * closingVol * lot * commRate * 2;
    return {
      price, remainingVol, closingVol, lot,
      gross, commission,
      net: (trade.pnl ?? 0) + gross - commission,
      realized: trade.pnl ?? 0,
      closedShare: volume > 0 ? ((volume - remainingVol) / volume) * 100 : 0,
    };
  }, [state, trade, candles, closeShare, userProfile?.brokerTariff]);

  // Похожие исторические ситуации — та же когорта (число фиксаций профит-системы) и
  // направление, что у сделки сейчас. Датасет собран на дневном графике; если сама сделка
  // ведётся на другом таймфрейме, честно показываем это несовпадение, а не молчим о нём.
  const similar = useMemo(() => {
    if (!sample || !state?.actual) return null;
    return findSimilar(sample, { cohort: state.actual.cohort, direction: trade?.direction === 'short' ? 'short' : 'long' });
  }, [sample, state, trade]);
  const goalProbability = useMemo(
    () => (similar ? probabilityOfGoal(similar.deciles, goal) : null),
    [similar, goal],
  );

  // Саму фиксацию/закрытие всегда делает Журнал — тем же расчётом (шаг цены, комиссия),
  // которым уже считает P&L. Кабина только подсказывает долю и открывает готовую модалку.
  const goToClose = useCallback((t, qty) => {
    const params = new URLSearchParams({ close: t.id });
    if (qty != null) params.set('qty', String(Math.max(1, Math.round(qty))));
    navigate(`/journal?${params.toString()}`);
  }, [navigate]);

  // CandleChart ждёт ОБЪЕКТЫ {key, label, ...} — Журнал передаёт именно их через
  // availableTimeframes. Здесь раньше передавались строки ('M5', 'H1', …), поэтому
  // tf.key был undefined: над графиком рисовались пустые кнопки без подписи, и нажатие
  // на них ничего не переключало (реальная жалоба: «пять непонятных пустых окошек»).
  const tfOptions = useMemo(
    () => availableTimeframes(!!userProfile?.tinkoffToken),
    [userProfile?.tinkoffToken],
  );

  if (loading) return <div className="ck-wrap"><div className="ck-loading">Загружаю открытые позиции…</div></div>;

  if (!trades.length) {
    return (
      <div className="ck-wrap">
        <div className="ck-panel ck-blank">
          <h2>Открытых позиций нет</h2>
          <p>
            Вкладка показывает сделку изнутри, пока она в рынке: что видят профит- и
            лосс-системы, где были фиксации и что сделал бы движок на твоём месте.
          </p>
          <p className="ck-muted">
            Открой сделку в <Link to="/journal">Журнале</Link> или посчитай вход
            в <Link to="/calculator">Калькуляторе</Link> — она появится здесь автоматически.
          </p>
        </div>
      </div>
    );
  }

  const a = state?.actual;
  const s = state?.shadow;
  const base = (!showMe && s) ? s : a;
  const verdictAction = alerts.some((x) => x.severity === 'action' || x.severity === 'danger');

  return (
    <div className="ck-wrap">
      <div className="ck-top">
        <div>
          <h1 className="ck-title">Сопровождение</h1>
          <div className="ck-sub">Открытая позиция изнутри</div>
        </div>
        <div className="ck-top-right">
          <label className="ck-strategy-pick">
            {/* Тип рядом с названием: «Стратегия 2» ничего не говорит о том, чего от неё
                ждать, а «Пробойная» говорит — и сразу видно, что переключение меняет не
                только имя в селекторе. */}
            <span className="ck-k">
              Работаем по стратегии
              {strategy && <span className="ck-strategy-kind"> · {kindBadge(classifyStrategy(strategy)).toLowerCase()}</span>}
            </span>
            <select
              value={strategy?.id || ''}
              onChange={(e) => setStrategyId(e.target.value)}
              disabled={strategies.length < 2}
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name || 'без названия'}</option>
              ))}
            </select>
          </label>
          <button className="ck-btn" onClick={recompute} disabled={computing}>
            {computing ? 'Считаю…' : '⟳ Обновить'}
          </button>
        </div>
      </div>

      {noExitRules && (
        <div className="ck-strategy-warn">
          У стратегии «{strategy?.name || 'без названия'}» не настроены правила ведения позиции —
          вкладке нечем считать: ни пика, ни счёта систем, ни предложений по фиксации.
          Откройте <Link to="/capital">Капитал → правила выхода</Link> и включите хотя бы трейлинг.
          {strategies.length < 2 && ' Там же можно завести вторую стратегию, чтобы переключаться между ними здесь.'}
        </div>
      )}

      {/* Сделка была открыта по одной стратегии, а вкладка сейчас ведёт её по другой —
          это законный режим «примерить другие правила», но он должен быть виден. */}
      {trade?.entryStrategyName && strategy?.name && trade.entryStrategyName !== strategy.name && (
        <div className="ck-strategy-warn">
          Сделка открыта по стратегии «{trade.entryStrategyName}», а вкладка сейчас считает
          по «{strategy.name}» — правила выхода отличаются.
        </div>
      )}

      <div className="ck-layout">
        {/* ---------- сайдбар: позиции, лесенка, радар — одна колонка, каждая секция
            сворачивается сама по себе, без пустых мест на месте свёрнутого блока ---------- */}
        <aside className="ck-side">
          <CollapsibleSection title="Открытые позиции" badge={trades.length}>
            <div className="ck-pos-list">
              {trades.map((t) => {
                const on = t.id === activeId;
                const rem = parseFloat(t.remainingVolume ?? t.volume) || 0;
                const vol = parseFloat(t.volume) || 0;
                return (
                  <div key={t.id} className={`ck-pos ${on ? 'on' : ''}`}>
                    <button className="ck-pos-main" onClick={() => setActiveId(t.id)}>
                      <div className="ck-pos-row">
                        <span className="ck-ticker">{t.ticker}</span>
                        <span className={`ck-dir ${t.direction}`}>{t.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</span>
                      </div>
                      <div className="ck-pos-sub">
                        {t.status === 'partial' ? `в рынке ${fmtNum(rem, 0)} из ${fmtNum(vol, 0)}` : `${fmtNum(vol, 0)} конт.`}
                      </div>
                      <div className="ck-pos-sub">вход {fmtNum(t.entryPrice)}</div>
                    </button>
                    <button className="ck-pos-close" onClick={() => goToClose(t)} title="Закрыть или зафиксировать часть">
                      Закрыть
                    </button>
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>

          {trade && (
            <CollapsibleSection title="Лесенка фиксаций" badge={(state?.actualFills || []).length}>
              <div className="ck-ladder-body">
                {(state?.actualFills || []).length === 0 && (
                  <div className="ck-rung muted">
                    <div className="ck-rung-1">Пока ни одной</div>
                    <div className="ck-rung-2">позиция целиком в рынке</div>
                  </div>
                )}
                {(state?.actualFills || []).map((f, idx) => (
                  <div className="ck-rung" key={idx}>
                    <div className="ck-rung-1">{Math.round(f.fraction * 100)}% · {fmtNum(f.price)}</div>
                    <div className="ck-rung-2">
                      {f.timestampUtc ? new Date(f.timestampUtc).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                    </div>
                  </div>
                ))}
                {/* Что предлагал движок, а ты этого не делал */}
                {(s?.fired || []).filter((f) => !(state?.actualFills || [])
                  .some((x) => Math.abs(x.index - f.index) <= 1)).map((f, idx) => (
                    <div className="ck-rung sys" key={`s${idx}`}>
                      <div className="ck-rung-1">{Math.round((f.fraction || 0) * 100)}% · {fmtNum(f.price)}</div>
                      <div className="ck-rung-2">система фиксировала здесь</div>
                    </div>
                ))}
                {money && (
                  <div className="ck-rung now">
                    <div className="ck-rung-1">{fmtNum(money.remainingVol, 0)} конт. · {fmtNum(money.price)}</div>
                    <div className="ck-rung-2">сейчас в рынке · {fmtPct(a?.currentPct, 1)}</div>
                  </div>
                )}
              </div>
            </CollapsibleSection>
          )}

          <RadarPanel />
        </aside>

        {/* ---------- кабина ---------- */}
        <main className="ck-main">
          {error && <div className="ck-panel ck-error">{error}</div>}

          {trade && (
            <section className="ck-panel ck-head">
              <div className="ck-head-id">
                <span className="ck-head-ticker">{trade.ticker}</span>
                <span className={`ck-dir ${trade.direction}`}>
                  {trade.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}
                </span>
              </div>

              {/* Две линии: что получилось у тебя и что было бы, если бы слушался движка */}
              <div className="ck-lines">
                <button
                  className={`ck-line ${showMe ? 'on' : 'off'}`}
                  onClick={() => (showMe && !showSys ? null : setShowMe(!showMe))}
                >
                  <span className="ck-k">Факт · ты</span>
                  <span className={`ck-line-v ${(a?.currentPct ?? 0) >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(a?.currentPct)}
                  </span>
                  <span className="ck-line-sub">{fmtNum(trade.entryPrice)} → {fmtNum(money?.price)}</span>
                </button>
                <button
                  className={`ck-line ${showSys ? 'on' : 'off'}`}
                  onClick={() => (showSys && !showMe ? null : setShowSys(!showSys))}
                >
                  <span className="ck-k">Система</span>
                  {/* Итог линии, а не цена последнего бара: движок фиксировал по пути и,
                      возможно, уже вышел — по текущей цене обе линии всегда совпадали. */}
                  <span className={`ck-line-v ${(s?.resultPct ?? 0) >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(s?.resultPct)}
                  </span>
                  <span className="ck-line-sub">
                    {s?.exit ? `закрыла бы: ${s.exit.reason}` : `фиксаций: ${s?.profitCutsDone ?? 0}`}
                  </span>
                </button>
                {state && (
                  <span className={`ck-delta ${Math.abs(state.deltaPct) < 0.05 ? 'flat' : (state.deltaPct > 0 ? 'good' : 'bad')}`}>
                    {Math.abs(state.deltaPct) < 0.05
                      ? 'решения совпали'
                      : `${state.deltaPct > 0 ? 'ты впереди на ' : 'отставание '}${Math.abs(state.deltaPct).toFixed(2)} п.п.`}
                  </span>
                )}
              </div>

              <div className="ck-stats">
                <div className="ck-stat">
                  <span className="ck-k">Пик</span>
                  <span className="ck-v gold">{fmtPct(base?.peakPct, 1)}</span>
                  <span className="ck-line-sub">отдано {fmtNum(base?.givebackPct, 1)} п.п.</span>
                </div>
                <div className="ck-stat">
                  <span className="ck-k">Держим</span>
                  <span className="ck-v">{base?.barsHeld ?? '—'} бар.</span>
                  <span className="ck-line-sub">{timeframe}</span>
                </div>
                <div className="ck-stat">
                  <span className="ck-k">Когорта</span>
                  <span className="ck-v">{base?.cohort ?? '—'} фикс.</span>
                  <span className="ck-line-sub">в рынке {Math.round((base?.remaining ?? 1) * 100)}%</span>
                </div>
                {trade.stopLoss && (
                  <div className="ck-stat">
                    <span className="ck-k">Стоп из плана</span>
                    <span className="ck-v down">{fmtNum(trade.stopLoss)}</span>
                  </div>
                )}
                {trade.takeProfit && (
                  <div className="ck-stat">
                    <span className="ck-k">Цель из плана</span>
                    <span className="ck-v up">{fmtNum(trade.takeProfit)}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ---------- вердикт ---------- */}
          {state && (
            <section className={`ck-panel ck-verdict ${verdictAction ? 'act' : ''}`}>
              <div className="ck-verdict-bar" />
              <div className="ck-verdict-text">
                <div className="ck-verdict-label">
                  {verdictAction ? 'Требуется решение' : 'Действий не требуется'}
                </div>
                <div className="ck-verdict-title">
                  {alerts.length ? alerts[0].title : 'Обе системы молчат — движок держит позицию'}
                </div>
                <div className="ck-verdict-body">
                  {alerts.length
                    ? alerts[0].body
                    : `Профит-система ${a?.now?.profitScore ?? '—'} из ${exitRules.profitCaptureThreshold ?? 4}`
                      + `, лосс-система ${a?.now?.lossScore ?? '—'} из ${exitRules.lossScoreThreshold ?? 2}.`}
                </div>
              </div>
              <button
                className="ck-btn ck-btn-primary"
                onClick={() => goToClose(trade, alerts[0]?.suggestedShare && money
                  ? money.remainingVol * (alerts[0].suggestedShare / 100) : undefined)}
              >
                Зафиксировать в Журнале
              </button>
            </section>
          )}

          {/* ---------- график ---------- */}
          <section className="ck-panel ck-chart">
            {candles?.length ? (
              <CandleChart
                candles={candles}
                patterns={patterns}
                ticker={trade?.ticker}
                timeframe={timeframe}
                timeframeOptions={tfOptions}
                onTimeframeChange={setTfOverride}
                legs={trade?.legs}
                direction={trade?.direction}
                entryPrice={trade?.entryPrice ? parseFloat(trade.entryPrice) : null}
                planLines={{
                  entry: trade?.entryPrice ? parseFloat(trade.entryPrice) : null,
                  stop: trade?.stopLoss ? parseFloat(trade.stopLoss) : null,
                  take: trade?.takeProfit ? parseFloat(trade.takeProfit) : null,
                }}
              />
            ) : (
              <div className="ck-loading">{computing ? 'Загружаю график…' : 'Нет данных'}</div>
            )}
          </section>

          {/* ---------- если закрыть сейчас ---------- */}
          {money && (
            <section className="ck-panel ck-calc">
              <h3>Если закрыть сейчас</h3>
              <div className="ck-shares">
                {[25, 50, 100].map((sh) => (
                  <button
                    key={sh}
                    className={`ck-share ${closeShare === sh ? 'on' : ''}`}
                    onClick={() => setCloseShare(sh)}
                  >
                    {sh}% остатка
                  </button>
                ))}
              </div>
              <div className="ck-calc-grid">
                <div><span className="ck-k">Закрываем</span><b>{fmtNum(money.closingVol, 0)} конт. по {fmtNum(money.price)}</b></div>
                <div><span className="ck-k">Грязными</span><b>{fmtRub(money.gross)}</b></div>
                <div><span className="ck-k">Комиссия</span><b className="down">{fmtRub(-money.commission)}</b></div>
                <div><span className="ck-k">Уже зафиксировано</span><b>{fmtRub(money.realized)}</b></div>
                <div><span className="ck-k">Итого по сделке</span>
                  <b className={money.net >= 0 ? 'up' : 'down'}>{fmtRub(money.net)}</b></div>
              </div>
              <div className="ck-calc-foot">
                <div className="ck-note">
                  Цифры считаются теми же полями сделки, что и в Журнале — шаг цены, стоимость шага, комиссия.
                </div>
                <button className="ck-btn ck-btn-primary" onClick={() => goToClose(trade, money.closingVol)}>
                  Зафиксировать {closeShare}% в Журнале
                </button>
              </div>
            </section>
          )}

          {/* ---------- похожие исторические ситуации ----------
              Выборка получена прогоном стратегии с частичными фиксациями, и разрезана она
              по числу этих фиксаций. Стратегии без них она бы ничего не сказала: когорта
              «0 фиксаций» у неё была бы всегда, то есть разреза нет. */}
          {similar && usesProfitSystem && (
            <section className="ck-panel ck-hist">
              <div className="ck-hist-top">
                <h3>Что было дальше в похожих ситуациях</h3>
                {similar.timeframe !== timeframe && (
                  <span className="ck-hist-warn">
                    выборка с {similar.timeframe === 'D1' ? 'дневного' : similar.timeframe} графика — сделка ведётся на {timeframe}
                  </span>
                )}
              </div>
              <div className="ck-hist-note">
                {similar.n} сделок из бэктеста той же когорты ({base.cohort} фикс.) и направления · это реальный результат исследования, не прогноз
              </div>
              <div className="ck-hist-grid">
                <div>
                  <div className="ck-dec">
                    {similar.deciles.map((d, i) => {
                      const dmax = Math.max(...similar.deciles.map((x) => Math.abs(x)), 1);
                      return (
                        <i key={i} style={{
                          height: `${Math.max(6, (Math.abs(d) / dmax) * 70)}px`,
                          background: d >= 0 ? 'var(--green)' : 'var(--red)',
                          opacity: 0.35 + 0.6 * (Math.abs(d) / dmax),
                        }} />
                      );
                    })}
                  </div>
                  <div className="ck-decax"><span>худшие 10%</span><span>медиана</span><span>лучшие 10%</span></div>
                  <div className="ck-hist-reasons">
                    {similar.exitReasons.map((r) => (
                      <div key={r.reason} className="ck-hist-reason">
                        <span>{r.reason}</span>
                        <span className="ck-muted">{Math.round(r.share * 100)}% · {fmtPct(r.avgPnl, 1)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="ck-fore">
                  <div className="ck-goal-row">
                    <span className="ck-k">Цель</span>
                    <div className="ck-stepper">
                      <button onClick={() => setGoal((g) => g - 1)}>−</button>
                      <span className="ck-gv">{goal >= 0 ? '+' : ''}{goal}%</span>
                      <button onClick={() => setGoal((g) => g + 1)}>+</button>
                    </div>
                  </div>
                  <div className="ck-gnum">
                    <b>{goalProbability}%</b>
                    <span>сделок из этой когорты дошли до {goal >= 0 ? '+' : ''}{goal}%</span>
                  </div>
                  <div className="ck-note">
                    Средний срок такой сделки — {similar.avgBars.toFixed(0)} баров ({similar.timeframe}).
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ---------- системы ----------
              Панели показываются, только если ВАША стратегия действительно этими
              системами пользуется. Показывать счёт системы, которая в стратегии
              выключена, — значит предлагать решение по правилам, по которым сделка не
              ведётся: цифра есть, а смысла у неё нет. */}
          <div className="ck-two">
            {usesProfitSystem ? (
              <ScorePanel
                title="Профит-система"
                hint="когда фиксировать часть прибыли"
                score={a?.now?.profitScore}
                threshold={exitRules.profitCaptureThreshold ?? 4}
                max={8}
                breakdown={breakdowns.profit}
                reached={(a?.now?.profitScore ?? -99) >= (exitRules.profitCaptureThreshold ?? 4)}
                tone="gold"
              />
            ) : (
              <SystemOff
                title="Профит-система"
                text="Ваша стратегия не фиксирует прибыль частями. Включите это в правилах выхода —
                      и здесь появится счёт: по каким признакам стоит снять часть прямо сейчас."
              />
            )}
            {usesLossSystem ? (
              <ScorePanel
                title="Лосс-система"
                hint="выше — похоже на дно, ниже — падение продолжается"
                score={a?.now?.lossScore}
                threshold={exitRules.lossScoreThreshold ?? 2}
                max={6}
                breakdown={breakdowns.loss}
                reached={(a?.now?.lossScore ?? 99) <= (exitRules.lossScoreThreshold ?? 2)}
                tone="red"
              />
            ) : (
              <SystemOff
                title="Лосс-система"
                text="Убытки в вашей стратегии закрываются обычным стопом, без разбора динамики.
                      Если включить правило выхода по счёту, здесь будет видно, похоже ли текущее
                      падение на дно или на продолжение."
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
