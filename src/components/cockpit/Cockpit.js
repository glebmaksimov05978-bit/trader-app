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
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, resolveOpenedAt } from '../../services/trades';
import { fetchDailyCandles, TIMEFRAMES } from '../../services/marketData/candles';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { getActiveStrategy } from '../../services/analytics/strategy';
import { computeBothLines } from '../../services/backtest/livePosition';
import { computeProfitBreakdown, computeLossBreakdown } from '../../services/backtest/engine';
import { evaluateAlerts, DEFAULT_ALERT_PREFS } from '../../services/alerts';
import CandleChart from '../shared/CandleChart';
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

export default function Cockpit() {
  const { user, userProfile } = useAuth();
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

  const strategy = useMemo(() => getActiveStrategy(userProfile), [userProfile]);
  const exitRules = strategy?.exitRules || {};

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
    const commRate = parseFloat(trade.commissionRate) || 0.0006;
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
  }, [state, trade, candles, closeShare]);

  const tfOptions = useMemo(
    () => Object.keys(TIMEFRAMES).filter((k) => !TIMEFRAMES[k].requiresToken || userProfile?.tinkoffToken),
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
          <div className="ck-sub">Открытая позиция изнутри · стратегия «{strategy?.name || 'без названия'}»</div>
        </div>
        <div className="ck-top-right">
          <button className="ck-btn" onClick={recompute} disabled={computing}>
            {computing ? 'Считаю…' : '⟳ Обновить'}
          </button>
        </div>
      </div>

      <div className="ck-layout">
        {/* ---------- список позиций ---------- */}
        <aside className="ck-panel ck-list">
          <div className="ck-list-head">Открытые позиции</div>
          {trades.map((t) => {
            const on = t.id === activeId;
            const rem = parseFloat(t.remainingVolume ?? t.volume) || 0;
            const vol = parseFloat(t.volume) || 0;
            return (
              <button key={t.id} className={`ck-pos ${on ? 'on' : ''}`} onClick={() => setActiveId(t.id)}>
                <div className="ck-pos-row">
                  <span className="ck-ticker">{t.ticker}</span>
                  <span className={`ck-dir ${t.direction}`}>{t.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</span>
                </div>
                <div className="ck-pos-sub">
                  {t.status === 'partial' ? `в рынке ${fmtNum(rem, 0)} из ${fmtNum(vol, 0)}` : `${fmtNum(vol, 0)} конт.`}
                </div>
                <div className="ck-pos-sub">вход {fmtNum(t.entryPrice)}</div>
              </button>
            );
          })}
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
                  <span className={`ck-line-v ${(s?.currentPct ?? 0) >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(s?.currentPct)}
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
              <Link className="ck-btn ck-btn-primary" to="/journal">Зафиксировать в Журнале</Link>
            </section>
          )}

          {/* ---------- график + лесенка ---------- */}
          <section className="ck-chart-row">
            <div className="ck-panel ck-chart">
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
            </div>

            <div className="ck-panel ck-ladder">
              <div className="ck-list-head">Лесенка фиксаций</div>
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
              <div className="ck-note">
                Цифры считаются теми же полями сделки, что и в Журнале — шаг цены, стоимость шага, комиссия.
              </div>
            </section>
          )}

          {/* ---------- системы ---------- */}
          <div className="ck-two">
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
          </div>
        </main>
      </div>
    </div>
  );
}
