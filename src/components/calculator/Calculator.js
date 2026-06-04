// src/components/calculator/Calculator.js
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { TinkoffAPI, parseFutureInfo } from '../../services/tinkoff';
import { calcTrade, formatCurrency, formatNumber } from '../../utils/calculator';
import toast from 'react-hot-toast';
import './Calculator.css';

const DIRECTIONS = ['Лонг', 'Шорт'];

function ResultRow({ label, value, color, large }) {
  return (
    <div className="result-row">
      <span className="result-label">{label}</span>
      <span className={`result-value ${large ? 'result-value-lg' : ''}`} style={color ? {color} : {}}>
        {value}
      </span>
    </div>
  );
}

export default function Calculator() {
  const { userProfile } = useAuth();

  const [form, setForm] = useState({
    ticker: '',
    direction: 'Лонг',
    entryPrice: '',
    stopLoss: '',
    takeProfit: '',
    depositSize: String(userProfile?.depositSize ?? 0),
    riskPercent: userProfile?.maxRiskPerTrade || '1',
    lot: '1',
    minStep: '1',
    minStepAmount: '',
    initialMargin: '',
    commissionRate: '0.0006',
  });

  const [result, setResult] = useState(null);
  const [instrumentInfo, setInstrumentInfo] = useState(null);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [tapi, setTapi] = useState(null);

  useEffect(() => {
    if (userProfile?.tinkoffToken) {
      setTapi(new TinkoffAPI(userProfile.tinkoffToken));
    }
  }, [userProfile]);

  useEffect(() => {
    if (userProfile) {
      setForm(f => ({
        ...f,
        depositSize: userProfile.depositSize || f.depositSize,
        riskPercent: userProfile.maxRiskPerTrade || f.riskPercent,
      }));
    }
  }, [userProfile]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  // Auto-calculate on any change
  useEffect(() => {
    const r = calcTrade({
      entryPrice: form.entryPrice,
      stopLoss: form.stopLoss,
      takeProfit: form.takeProfit,
      depositSize: form.depositSize,
      riskPercent: form.riskPercent,
      lot: form.lot,
      minStep: form.minStep,
      minStepAmount: form.minStepAmount,
      initialMargin: form.initialMargin,
      commissionRate: form.commissionRate,
    });
    setResult(r);
  }, [form]);

  // Load instrument from Tinkoff
  const loadInstrument = useCallback(async () => {
    if (!tapi || !form.ticker) {
      toast.error('Введите тикер и API-токен в настройках');
      return;
    }
    setLoadingPrice(true);
    try {
      const future = await tapi.getFutureByTicker(form.ticker.toUpperCase());
      if (!future) {
        toast.error(`Инструмент ${form.ticker} не найден`);
        return;
      }
      const info = parseFutureInfo(future);
      setInstrumentInfo(info);

      // Get last price
      const price = await tapi.getLastPrice(info.figi);

      setForm(f => ({
        ...f,
        entryPrice: price ? String(price) : f.entryPrice,
        lot: String(info.lot || 1),
        minStep: String(info.minPriceIncrement || 1),
        minStepAmount: String(info.minPriceIncrementAmount || ''),
        initialMargin: String(info.initialMarginOnBuy || info.initialMarginOnSell || ''),
      }));

      toast.success(`${info.name} загружен. Цена: ${price}`);
    } catch (err) {
      toast.error(`Ошибка: ${err.message}`);
    } finally {
      setLoadingPrice(false);
    }
  }, [tapi, form.ticker]);

  const rrColor = !result ? '' : result.rr >= 2 ? 'var(--green)' : result.rr >= 1 ? 'var(--gold)' : 'var(--red)';

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🧮 Калькулятор сделки</h1>
        <p className="page-subtitle">Автоматический расчёт параметров позиции</p>
      </div>

      <div className="calc-layout">
        {/* Input panel */}
        <div className="card calc-input-panel">
          {/* Ticker row */}
          <div className="calc-section-title">Инструмент</div>
          <div className="calc-ticker-row">
            <div className="input-group" style={{flex:1}}>
              <label className="input-label">Тикер</label>
              <input
                className="input"
                value={form.ticker}
                onChange={e => set('ticker', e.target.value.toUpperCase())}
                placeholder="SRZ4, MXZ4..."
                style={{textTransform:'uppercase'}}
              />
            </div>
            <div className="input-group" style={{width:110}}>
              <label className="input-label">&nbsp;</label>
              <button
                className="btn btn-secondary w-full"
                onClick={loadInstrument}
                disabled={loadingPrice || !form.ticker}
              >
                {loadingPrice ? <div className="spinner" style={{width:14,height:14}}/> : '🔄'} Загрузить
              </button>
            </div>
          </div>

          {/* Instrument info badge */}
          {instrumentInfo && (
            <div className="instrument-info">
              <span className="badge badge-purple">{instrumentInfo.ticker}</span>
              <span className="text-sm text-secondary">{instrumentInfo.name}</span>
              {instrumentInfo.expirationDate && (
                <span className="text-xs text-muted">
                  Экспирация: {new Date(instrumentInfo.expirationDate).toLocaleDateString('ru-RU')}
                </span>
              )}
            </div>
          )}

          {/* Direction */}
          <div className="calc-section-title" style={{marginTop:16}}>Направление</div>
          <div className="tabs" style={{marginBottom:16}}>
            {DIRECTIONS.map(d => (
              <button
                key={d}
                className={`tab ${form.direction === d ? 'active' : ''}`}
                onClick={() => set('direction', d)}
              >
                {d === 'Лонг' ? '📈' : '📉'} {d}
              </button>
            ))}
          </div>

          {/* Price inputs */}
          <div className="calc-section-title">Цены</div>
          <div className="grid-3" style={{marginBottom:12}}>
            <div className="input-group">
              <label className="input-label">Цена входа</label>
              <input className="input" type="number" value={form.entryPrice}
                onChange={e => set('entryPrice', e.target.value)} placeholder="0" />
            </div>
            <div className="input-group">
              <label className="input-label">Стоп-лосс</label>
              <input className="input" type="number" value={form.stopLoss}
                onChange={e => set('stopLoss', e.target.value)} placeholder="0"
                style={{borderColor: form.stopLoss && form.entryPrice
                  ? (form.direction === 'Лонг' ? parseFloat(form.stopLoss) < parseFloat(form.entryPrice) : parseFloat(form.stopLoss) > parseFloat(form.entryPrice))
                    ? 'var(--red)' : 'var(--border-subtle)'
                  : undefined}}
              />
            </div>
            <div className="input-group">
              <label className="input-label">Тейк-профит</label>
              <input className="input" type="number" value={form.takeProfit}
                onChange={e => set('takeProfit', e.target.value)} placeholder="0 (опц.)"
                style={{borderColor: form.takeProfit && form.entryPrice
                  ? (form.direction === 'Лонг' ? parseFloat(form.takeProfit) > parseFloat(form.entryPrice) : parseFloat(form.takeProfit) < parseFloat(form.entryPrice))
                    ? 'var(--green)' : 'var(--border-subtle)'
                  : undefined}}
              />
            </div>
          </div>

          {/* Risk */}
          <div className="calc-section-title">Управление риском</div>
          <div className="grid-2" style={{marginBottom:12}}>
            <div className="input-group">
              <label className="input-label">Депозит (₽)</label>
              <input className="input" type="number" value={form.depositSize}
                onChange={e => set('depositSize', e.target.value)} placeholder="100000" />
            </div>
            <div className="input-group">
              <label className="input-label">Риск на сделку (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.1" value={form.riskPercent}
                  onChange={e => set('riskPercent', e.target.value)} placeholder="1" />
              </div>
            </div>
          </div>

          {/* Contract params */}
          <div className="calc-section-title">Параметры контракта</div>
          <div className="grid-2" style={{marginBottom:4}}>
            <div className="input-group">
              <label className="input-label">Лот (множитель)</label>
              <input className="input" type="number" value={form.lot}
                onChange={e => set('lot', e.target.value)} placeholder="1" />
            </div>
            <div className="input-group">
              <label className="input-label">ГО (₽ на контракт)</label>
              <input className="input" type="number" value={form.initialMargin}
                onChange={e => set('initialMargin', e.target.value)} placeholder="авто" />
            </div>
            <div className="input-group">
              <label className="input-label">Шаг цены</label>
              <input className="input" type="number" value={form.minStep}
                onChange={e => set('minStep', e.target.value)} placeholder="1" />
            </div>
            <div className="input-group">
              <label className="input-label">Стоимость шага (₽)</label>
              <input className="input" type="number" value={form.minStepAmount}
                onChange={e => set('minStepAmount', e.target.value)} placeholder="авто" />
            </div>
          </div>
          <div className="input-group" style={{marginTop:8}}>
            <label className="input-label">Комиссия (доля, напр. 0.0006 = 0.06%)</label>
            <input className="input" type="number" step="0.0001" value={form.commissionRate}
              onChange={e => set('commissionRate', e.target.value)} />
          </div>
        </div>

        {/* Results panel */}
        <div className="calc-results-panel">
          {result ? (
            <>
              {/* Key metrics */}
              <div className="calc-key-metrics">
                <div className={`calc-metric-card ${result.direction === 'long' ? 'green' : 'red'}`}>
                  <div className="calc-metric-label">Контракты</div>
                  <div className="calc-metric-value">{result.contracts}</div>
                  <div className="calc-metric-sub">шт.</div>
                </div>
                <div className={`calc-metric-card ${result.rr >= 2 ? 'green' : result.rr >= 1 ? 'gold' : 'red'}`}>
                  <div className="calc-metric-label">Risk/Reward</div>
                  <div className="calc-metric-value" style={{color: rrColor}}>1:{formatNumber(result.rr, 1)}</div>
                  <div className="calc-metric-sub">{result.rr >= 2 ? '✅ Отличный' : result.rr >= 1 ? '⚠️ Норм' : '❌ Плохой'}</div>
                </div>
                <div className="calc-metric-card blue">
                  <div className="calc-metric-label">ГО требуется</div>
                  <div className="calc-metric-value" style={{fontSize:20}}>{formatCurrency(result.totalMargin)}</div>
                  <div className="calc-metric-sub">{result.marginUsagePercent}% депозита</div>
                </div>
              </div>

              {/* Results list */}
              <div className="card">
                <div className="section-title">
                  <div className="section-title-icon">📋</div>
                  Детализация
                </div>
                <ResultRow label="Риск на сделку" value={formatCurrency(result.riskAmount)} color="var(--red)" />
                <ResultRow label="Тиков до SL" value={formatNumber(result.ticksToSL)} />
                <ResultRow label="Тиков до TP" value={result.ticksToTP > 0 ? formatNumber(result.ticksToTP) : '—'} />
                <ResultRow label="Убыток на контракт" value={formatCurrency(result.lossPerContract)} color="var(--red)" />
                <ResultRow label="Прибыль на контракт" value={result.profitPerContract > 0 ? formatCurrency(result.profitPerContract) : '—'} color="var(--green)" />
                <ResultRow label="Комиссия" value={formatCurrency(result.commission)} />
                <ResultRow label="Точка безубытка" value={formatNumber(result.breakeven, 1)} />
                <div className="divider" />
                <ResultRow
                  label="Макс. убыток (с комис.)"
                  value={formatCurrency(result.totalLoss)}
                  color="var(--red)"
                  large
                />
                {result.totalProfit > 0 && (
                  <ResultRow
                    label="Потенц. прибыль (с комис.)"
                    value={formatCurrency(result.totalProfit)}
                    color="var(--green)"
                    large
                  />
                )}
              </div>

              {/* Visual risk gauge */}
              <div className="card">
                <div className="section-title">
                  <div className="section-title-icon">⚡</div>
                  Использование капитала
                </div>
                <div className="risk-gauge-wrap">
                  <div className="risk-gauge-bar">
                    <div
                      className="risk-gauge-fill"
                      style={{
                        width: `${Math.min(result.marginUsagePercent, 100)}%`,
                        background: result.marginUsagePercent > 50 ? 'linear-gradient(90deg,#f59e0b,#ef4444)' :
                          result.marginUsagePercent > 25 ? 'linear-gradient(90deg,#4f46e5,#f59e0b)' :
                          'var(--accent-gradient)'
                      }}
                    />
                  </div>
                  <div className="risk-gauge-labels">
                    <span className="text-sm text-secondary">ГО: {formatCurrency(result.totalMargin)}</span>
                    <span className="text-sm font-semibold" style={{
                      color: result.marginUsagePercent > 50 ? 'var(--red)' : 'var(--text-primary)'
                    }}>{result.marginUsagePercent}%</span>
                  </div>
                </div>
                <div style={{marginTop:8, fontSize:12, color:'var(--text-muted)'}}>
                  {result.marginUsagePercent > 70 ? '⚠️ Высокая загрузка депозита — рискованно' :
                    result.marginUsagePercent > 40 ? '🟡 Умеренная загрузка депозита' :
                    '✅ Нормальная загрузка депозита'}
                </div>
              </div>
            </>
          ) : (
            <div className="card">
              <div className="empty-state">
                <div className="empty-state-icon">🧮</div>
                <div className="empty-state-title">Заполните параметры</div>
                <div className="empty-state-text">
                  Введите цену входа, стоп-лосс, размер депозита и риск — результат появится автоматически
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
