// src/components/backtest/Backtest.js
//
// Admin/trusted-only tool — the "internal instrument" phase agreed with the trader:
// prove the engine's numbers are honest on real history before any client sees a
// backtest result. Runs one of the trader's SAVED strategies (from Капитал) against real
// candle history via runBacktest() (services/backtest/engine.js) — same evaluateStrategy
// the Calculator/Radar/Journal already use, so every new condition added to the
// constructor is backtestable for free, no changes needed here.
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { fetchDailyCandles, TIMEFRAMES } from '../../services/marketData/candles';
import { runBacktest } from '../../services/backtest/engine';
import { getStrategies, getActiveStrategy } from '../../services/analytics/strategy';
import { defaultExitRules } from '../../services/analytics/exitRules';
import { calcStats } from '../../services/trades';
import { formatNumber } from '../../utils/calculator';
import CandleChart from '../shared/CandleChart';
import ExitRulesEditor from '../shared/ExitRulesEditor';
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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { trades, hadCustomConditions, barsEvaluated, ambiguousBars, candles }
  const [selectedTradeIdx, setSelectedTradeIdx] = useState(null);

  const hasConditions = (selectedStrategy?.conditions?.length || 0) > 0;

  const run = async () => {
    if (!ticker.trim()) { toast.error('Введите тикер'); return; }
    if (!hasConditions) { toast.error('Сначала настройте условия входа в стратегии (вкладка Капитал)'); return; }
    setLoading(true);
    setError(null);
    setResult(null);
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

      const engineResult = runBacktest({
        candles, strategy: selectedStrategy, timeframeMinutes: TIMEFRAMES.D1.minutes,
        exitRules: { ...exitRules, maxBars: maxBarsEnabled ? exitRules.maxBars : null },
      });
      setResult({ ...engineResult, candles });
      if (!engineResult.trades.length) {
        toast('Ни одной сделки не найдено — стратегия ни разу не набрала нужный % за этот период', { icon: 'ℹ️' });
      }
    } catch (e) {
      setError(e.message || 'Не удалось запустить бэктест');
    } finally {
      setLoading(false);
    }
  };

  const stats = result?.trades?.length ? calcStats(result.trades) : null;
  const selectedTrade = selectedTradeIdx != null ? result?.trades?.[selectedTradeIdx] : null;

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
            <input className="input" type="number" min="1" max="10" step="0.5" value={years}
              onChange={(e) => setYears(parseFloat(e.target.value) || 1)} style={{width:70}} />
          </div>
        </div>

        <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:8}}>
          Правила выхода — подставлены из выбранной стратегии, можно временно подкрутить для этого прогона (в Капитале не сохранится)
        </div>
        <div style={{marginBottom:16}}>
          <ExitRulesEditor value={exitRules} onChange={setExitRules} maxBarsEnabled={maxBarsEnabled} onMaxBarsEnabledChange={setMaxBarsEnabled} />
        </div>

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

          {stats ? (
            <div className="grid-4" style={{gap:12, marginBottom:16}}>
              <StatCard label="Сделок" value={stats.total} />
              <StatCard label="Винрейт" value={`${formatNumber(stats.winrate, 1)}%`} tone={stats.winrate >= 50 ? 'green' : 'red'} />
              <StatCard label="Профит-фактор" value={stats.profitFactor === Infinity ? '∞' : formatNumber(stats.profitFactor, 2)} tone={stats.profitFactor >= 1 ? 'green' : 'red'} />
              <StatCard label="Средний P&L / сделку" value={`${stats.totalPnl >= 0 ? '+' : ''}${formatNumber(stats.totalPnl / stats.total, 2)}%`} tone={stats.totalPnl >= 0 ? 'green' : 'red'} />
            </div>
          ) : (
            <div className="card empty-state" style={{marginBottom:16}}>
              <div className="empty-state-text">Ни одной завершённой сделки за этот период — стратегия ни разу не набрала нужный % готовности.</div>
            </div>
          )}

          {result.trades?.length > 0 && (
            <div className="card" style={{marginBottom:16}}>
              <div className="section-title"><div className="section-title-icon">📋</div>Сделки ({result.trades.length})</div>
              <div style={{overflowX:'auto'}}>
                <table className="table" style={{fontSize:13}}>
                  <thead>
                    <tr>
                      <th>Направление</th><th>Вход</th><th>Цена входа</th><th>% готовности</th>
                      <th>Выход</th><th>Цена выхода</th><th>Причина</th><th>Дней</th><th>P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i} onClick={() => setSelectedTradeIdx(i)}
                        style={{cursor:'pointer', background: selectedTradeIdx === i ? 'var(--bg-surface-3)' : undefined}}>
                        <td><span className={`badge ${t.direction === 'long' ? 'badge-green' : 'badge-red'}`}>{t.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}</span></td>
                        <td className="text-secondary">{t.entryDate.toLocaleDateString('ru-RU')}</td>
                        <td>{formatNumber(t.entryPrice, 2)}</td>
                        <td className="text-secondary">{formatNumber(t.entryPercent, 0)}%</td>
                        <td className="text-secondary">{t.exitDate.toLocaleDateString('ru-RU')}</td>
                        <td>{formatNumber(t.exitPrice, 2)}</td>
                        <td>{t.status === 'open' ? <span className="badge badge-blue">Ещё открыта</span> : EXIT_REASON_LABELS[t.exitReason] || t.exitReason}</td>
                        <td className="text-secondary">{t.barsHeld}</td>
                        <td className={t.pnlPct >= 0 ? 'text-green' : 'text-red'}>{t.pnlPct >= 0 ? '+' : ''}{formatNumber(t.pnlPct, 2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {selectedTrade && (
            <div className="card">
              <div className="section-title"><div className="section-title-icon">📊</div>Сделка на графике</div>
              <CandleChart
                candles={result.candles}
                ticker={ticker.toUpperCase()}
                direction={selectedTrade.direction}
                entryPrice={selectedTrade.entryPrice}
                exitPrice={selectedTrade.status === 'closed' ? selectedTrade.exitPrice : null}
                entryMarker={{ date: selectedTrade.entryDate, price: selectedTrade.entryPrice, direction: selectedTrade.direction }}
                exitMarker={{ date: selectedTrade.exitDate, price: selectedTrade.exitPrice }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
