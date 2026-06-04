// src/components/calculator/Calculator.js
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { TinkoffAPI, parseFutureInfo } from '../../services/tinkoff';
import { calcTrade, formatCurrency, formatNumber } from '../../utils/calculator';
import { addTrade } from '../../services/trades';
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
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    ticker: '',
    direction: 'Лонг',
    entryPrice: '',
    stopLoss: '',
    takeProfit: '',
    depositSize: userProfile?.depositSize || '100000',
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
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [openingTrade, setOpeningTrade] = useState(false);
  const [manualContracts, setManualContracts] = useState('');
  const [instrumentType, setInstrumentType] = useState('future'); // future | stock
  const refreshTimer = useRef(null);

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
      maxMarginPercent: parseFloat(userProfile?.maxMarginPercent) || 30,
      instrumentType,
    });
    setResult(r);
  }, [form]);

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

      const price = await tapi.getLastPrice(info.figi);

      // Fix: format numbers properly with dot not comma
      const fmtNum = (n) => n ? String(n).replace(',', '.') : '';

      setForm(f => ({
        ...f,
        entryPrice: price ? String(price) : f.entryPrice,
        lot: String(info.lot || 1),
        minStep: fmtNum(info.minPriceIncrement) || '1',
        minStepAmount: fmtNum(info.minPriceIncrementAmount) || '',
        initialMargin: fmtNum(info.initialMargin) || '',
      }));

      toast.success(`${info.name} загружен. Цена: ${price}`);

      // Auto-refresh price every 30 seconds
      if (refreshTimer.current) clearInterval(refreshTimer.current);
      refreshTimer.current = setInterval(async () => {
        try {
          const newPrice = await tapi.getLastPrice(info.figi);
          if (newPrice) {
            setForm(f => ({ ...f, entryPrice: String(newPrice) }));
          }
        } catch {}
      }, 30000);

    } catch (err) {
      toast.error(`Ошибка: ${err.message}`);
    } finally {
      setLoadingPrice(false);
    }
  }, [tapi, form.ticker]);

  useEffect(() => {
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, []);

  // Open trade modal
  const handleOpenTrade = () => {
    if (!form.ticker || !form.entryPrice) {
      toast.error('Заполните тикер и цену входа');
      return;
    }
    setShowOpenModal(true);
  };

  const handleConfirmOpen = async () => {
    if (!user) return;
    setOpeningTrade(true);
    try {
      await addTrade(user.uid, {
        ticker: form.ticker.toUpperCase(),
        direction: form.direction === 'Лонг' ? 'long' : 'short',
        date: new Date().toISOString().split('T')[0],
        entryPrice: parseFloat(form.entryPrice),
        exitPrice: null,
        volume: effectiveContracts,
        pnl: null,
        commission: null,
        status: 'open',
        // Save all params for auto-calc on close
        minStep: parseFloat(form.minStep) || 1,
        minStepAmount: parseFloat(form.minStepAmount) || 0,
        lot: parseFloat(form.lot) || 1,
        commissionRate: parseFloat(form.commissionRate) || 0.0006,
        initialMargin: parseFloat(form.initialMargin) || 0,
        stopLoss: parseFloat(form.stopLoss) || null,
        takeProfit: parseFloat(form.takeProfit) || null,
        depositSize: parseFloat(form.depositSize) || 100000,
        notes: '',
      });
      toast.success('Сделка открыта и добавлена в журнал!');
      setShowOpenModal(false);
      navigate('/journal');
    } catch (err) {
      toast.error('Ошибка сохранения');
    } finally {
      setOpeningTrade(false);
    }
  };

  const effectiveContracts = manualContracts ? parseInt(manualContracts) : (result?.contracts || 1);
  const rrColor = !result ? '' : result.rr >= 2 ? 'var(--green)' : result.rr >= 1 ? 'var(--gold)' : 'var(--red)';

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🧮 Калькулятор сделки</h1>
        <p className="page-subtitle">Автоматический расчёт параметров позиции</p>
      </div>

      {/* Переключатель типа инструмента */}
      <div style={{
        display:'flex', gap:8, marginBottom:20,
        background:'var(--bg-surface-2)', borderRadius:16,
        padding:6, width:'fit-content',
      }}>
        {[
          {id:'future', label:'Фьючерс', icon:'⚡'},
          {id:'stock',  label:'Акция',   icon:'📈'},
        ].map(t => (
          <button
            key={t.id}
            onClick={() => {
              setInstrumentType(t.id);
              setManualContracts('');
              setForm(f => ({
                ...f,
                ticker: '',
                entryPrice: '',
                stopLoss: '',
                takeProfit: '',
                initialMargin: '',
                minStep: '1',
                minStepAmount: '0',
                lot: '1',
              }));
            }}
            style={{
              padding:'8px 20px', borderRadius:12, border:'none', cursor:'pointer',
              fontFamily:'inherit', fontSize:13, fontWeight:600,
              transition:'all 0.2s',
              background: instrumentType === t.id
                ? 'linear-gradient(135deg,#4f46e5,#7c3aed)'
                : 'transparent',
              color: instrumentType === t.id ? '#fff' : 'var(--text-muted)',
              boxShadow: instrumentType === t.id ? '0 4px 12px rgba(79,70,229,0.35)' : 'none',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="calc-layout">
        {/* Input panel */}
        <div className="card calc-input-panel">
          <div className="calc-section-title">Инструмент</div>
          <div className="calc-ticker-row">
            <div className="input-group" style={{flex:1}}>
              <label className="input-label">Тикер</label>
              <input
                className="input"
                value={form.ticker}
                onChange={e => set('ticker', e.target.value.toUpperCase())}
                placeholder="SRZ6, IMOEXF..."
                style={{textTransform:'uppercase'}}
              />
            </div>
            <div className="input-group" style={{width:120}}>
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

          {instrumentInfo && (
            <div className="instrument-info">
              <span className="badge badge-purple">{instrumentInfo.ticker}</span>
              <span className="text-sm text-secondary">{instrumentInfo.name}</span>
              {instrumentInfo.expirationDate && (
                <span className="text-xs text-muted">
                  Экспирация: {new Date(instrumentInfo.expirationDate).toLocaleDateString('ru-RU')}
                </span>
              )}
              <span className="text-xs text-muted" style={{color:'var(--green)'}}>🔄 авто-обновление 30с</span>
            </div>
          )}

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
                onChange={e => set('stopLoss', e.target.value)} placeholder="0" />
            </div>
            <div className="input-group">
              <label className="input-label">Тейк-профит</label>
              <input className="input" type="number" value={form.takeProfit}
                onChange={e => set('takeProfit', e.target.value)} placeholder="0 (опц.)" />
            </div>
          </div>

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

          <div className="calc-section-title">Параметры контракта</div>
          <div className="grid-2" style={{marginBottom:4}}>
            <div className="input-group">
              <label className="input-label">Лот (лотность)</label>
              <input className="input" type="number" value={form.lot}
                onChange={e => set('lot', e.target.value)} placeholder="1" />
            </div>
            <div className="input-group">
{instrumentType === 'future' && (
              <>
                <label className="input-label">ГО (₽ на контракт)</label>
                <input className="input" type="number" value={form.initialMargin}
                  onChange={e => set('initialMargin', e.target.value)} placeholder="авто" />
              </>
            )}
            {instrumentType === 'stock' && (
              <>
                <label className="input-label">ГО не нужно</label>
                <input className="input" disabled value="—" style={{opacity:0.4}} />
              </>
            )}
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
            <label className="input-label">Комиссия (0.0006 = 0.06%)</label>
            <input className="input" type="number" step="0.0001" value={form.commissionRate}
              onChange={e => set('commissionRate', e.target.value)} />
          </div>

          {/* Кнопки */}
          {result && result.contracts > 0 && (
            <div style={{display:'flex', gap:10, marginTop:16}}>
              <button
                className="btn btn-primary"
                style={{flex:1}}
                onClick={handleOpenTrade}
              >
                📂 В журнал
              </button>
              <button
                className="btn"
                style={{
                  background:'linear-gradient(135deg,#7c3aed,#4f46e5)',
                  color:'#fff', border:'none', borderRadius:14,
                  padding:'0 18px', cursor:'pointer',
                  fontWeight:600, fontSize:14, fontFamily:'inherit',
                }}
                onClick={() => {
                  const p = new URLSearchParams({
                    from:'calculator',
                    ticker: form.ticker || '',
                    entry: form.entryPrice || '',
                    sl: form.stopLoss || '',
                    tp: form.takeProfit || '',
                    contracts: String(effectiveContracts),
                    rr: String(result.rr),
                    direction: result.direction,
                  });
                  window.location.href = '/advisor?' + p.toString();
                }}
              >
                🤖 В AI
              </button>
            </div>
          )}
        </div>

        {/* Results panel */}
        <div className="calc-results-panel">
          {result ? (
            <>
              <div className="calc-key-metrics">
                <div className={`calc-metric-card ${result.direction === 'long' ? 'green' : 'red'}`} style={{position:'relative'}}>
                  <div className="calc-metric-label">{instrumentType === 'stock' ? 'Лотов' : 'Контрактов'}</div>
                  {/* Большое поле ввода вместо цифры */}
                  <div style={{display:'flex', alignItems:'baseline', gap:6, marginBottom:4}}>
                    <input
                      type="number"
                      min="1"
                      value={manualContracts}
                      onChange={e => setManualContracts(e.target.value)}
                      placeholder={String(result.contracts)}
                      style={{
                        width: '70px',
                        background: 'none',
                        border: 'none',
                        outline: 'none',
                        fontFamily: 'inherit',
                        fontSize: 36,
                        fontWeight: 800,
                        color: manualContracts ? 'var(--gold)' : 'var(--text-primary)',
                        padding: 0,
                        MozAppearance: 'textfield',
                      }}
                    />
                    <span style={{fontSize:14, color:'var(--text-muted)', fontWeight:500}}>шт.</span>
                  </div>
                  <div style={{fontSize:11, color:'var(--text-muted)'}}>
                    {manualContracts
                      ? <span style={{color:'var(--gold)'}}>✏️ ручной · авто: {result.contracts}</span>
                      : <span>авто по риску</span>
                    }
                  </div>
                </div>
                <div className={`calc-metric-card ${!result.rrValid && result.rr !== 0 ? 'red' : result.rr >= 2 ? 'green' : result.rr >= 1 ? 'gold' : 'red'}`}>
                  <div className="calc-metric-label">Risk/Reward</div>
                  {(!result.rrValid && result.rr !== 0) ? (
                    <>
                      <div className="calc-metric-value" style={{color:'var(--red)',fontSize:13}}>⚠️ TP не там!</div>
                      <div className="calc-metric-sub" style={{color:'var(--red)',fontSize:10}}>
                        {result.direction === 'long' ? 'TP должен быть выше входа' : 'TP должен быть ниже входа'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="calc-metric-value" style={{color: rrColor}}>1:{formatNumber(result.rr, 1)}</div>
                      <div className="calc-metric-sub">{result.rr >= 2 ? '✅ Отличный' : result.rr >= 1 ? '⚠️ Норм' : '❌ Плохой'}</div>
                    </>
                  )}
                </div>
                <div className={`calc-metric-card ${result.marginUsagePercent > (result.maxMarginPercent || 30) ? 'red' : 'blue'}`}>
                  <div className="calc-metric-label">{instrumentType === 'stock' ? 'Стоимость позиции' : 'ГО (заморозка)'}</div>
                  <div className="calc-metric-value" style={{fontSize:16}}>
                    {instrumentType === 'stock'
                      ? formatCurrency(result.positionValue)
                      : formatCurrency(result.totalMargin)}
                  </div>
                  <div className="calc-metric-sub" style={{
                    color: result.marginUsagePercent > (result.maxMarginPercent || 30) ? 'var(--red)' : ''
                  }}>
                    {instrumentType === 'future'
                      ? `${result.marginUsagePercent}% / лимит ${result.maxMarginPercent || 30}%`
                      : `${result.marginUsagePercent}% депозита`}
                  </div>
                  {instrumentType === 'future' && (
                    <div style={{
                      marginTop:6, paddingTop:6,
                      borderTop:'1px solid rgba(255,255,255,0.1)',
                      fontSize:11, color:'var(--text-muted)',
                    }}>
                      <div>Стоимость позиции:</div>
                      <div style={{color:'var(--text-primary)', fontWeight:600}}>
                        {formatCurrency(result.positionValue)}
                      </div>
                    </div>
                  )}
                </div>
              </div>

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
                <ResultRow label="Точка безубытка" value={formatNumber(result.breakeven, 2)} />
                <div className="divider" />
                <ResultRow label="Макс. убыток (с комис.)" value={formatCurrency(result.totalLoss)} color="var(--red)" large />
                {result.totalProfit > 0 && (
                  <ResultRow label="Потенц. прибыль (с комис.)" value={formatCurrency(result.totalProfit)} color="var(--green)" large />
                )}
              </div>

              <div className="card">
                <div className="section-title">
                  <div className="section-title-icon">⚡</div>
                  Использование капитала
                </div>
                <div className="risk-gauge-wrap">
                  <div className="risk-gauge-bar">
                    <div className="risk-gauge-fill" style={{
                      width: `${Math.min(result.marginUsagePercent, 100)}%`,
                      background: result.marginUsagePercent > 50 ? 'linear-gradient(90deg,#f59e0b,#ef4444)' :
                        result.marginUsagePercent > 25 ? 'linear-gradient(90deg,#4f46e5,#f59e0b)' :
                        'var(--accent-gradient)'
                    }} />
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

      {/* Open Trade Modal */}
      {showOpenModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowOpenModal(false)}>
          <div className="modal" style={{maxWidth:460}}>
            <div className="modal-header">
              <h2 className="modal-title">📂 Открыть сделку</h2>
              <button className="modal-close" onClick={() => setShowOpenModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="text-secondary text-sm" style={{marginBottom:16}}>
                Сделка будет добавлена в журнал со статусом «Открыта». Закроете её когда выйдете из позиции.
              </p>

              <div className="card" style={{padding:'16px', background:'var(--bg-surface-2)'}}>
                <div className="stat-row"><span className="stat-row-label">Тикер</span><span className="stat-row-value">{form.ticker}</span></div>
                <div className="stat-row"><span className="stat-row-label">Направление</span>
                  <span className={`badge ${form.direction === 'Лонг' ? 'badge-green' : 'badge-red'}`}>{form.direction}</span>
                </div>
                <div className="stat-row"><span className="stat-row-label">Цена входа</span><span className="stat-row-value">{form.entryPrice}</span></div>
                <div className="stat-row"><span className="stat-row-label">Стоп-лосс</span><span className="stat-row-value text-red">{form.stopLoss || '—'}</span></div>
                <div className="stat-row"><span className="stat-row-label">Тейк-профит</span><span className="stat-row-value text-green">{form.takeProfit || '—'}</span></div>
                <div className="stat-row"><span className="stat-row-label">Контрактов</span><span className="stat-row-value" style={{color: manualContracts ? 'var(--gold)' : ''}}>{effectiveContracts} {manualContracts ? '(ручной)' : '(авто)'}</span></div>
                <div className="stat-row"><span className="stat-row-label">ГО</span><span className="stat-row-value">{formatCurrency(result?.totalMargin)}</span></div>
                <div className="stat-row"><span className="stat-row-label">Макс. риск</span><span className="stat-row-value text-red">{formatCurrency(result?.totalLoss)}</span></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowOpenModal(false)}>Отмена</button>
              <button className="btn btn-primary" onClick={handleConfirmOpen} disabled={openingTrade}>
                {openingTrade ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : '✅ Открыть сделку'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
