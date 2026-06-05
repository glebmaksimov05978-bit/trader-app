// src/components/calculator/Calculator.js
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { TinkoffAPI, parseFutureInfo, parseShareInfo } from '../../services/tinkoff';
import { calcTrade, formatCurrency, formatNumber } from '../../utils/calculator';
import toast from 'react-hot-toast';
import './Calculator.css';

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
  const [instrumentType, setInstrumentType] = useState('future');
  const [manualContracts, setManualContracts] = useState('');
  const [form, setForm] = useState({
    ticker: '',
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
    if (userProfile?.tinkoffToken) setTapi(new TinkoffAPI(userProfile.tinkoffToken));
  }, [userProfile]);

  useEffect(() => {
    if (userProfile) {
      setForm(f => ({
        ...f,
        depositSize: String(userProfile.depositSize ?? 0),
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
  }, [form, instrumentType]);

  const effectiveContracts = manualContracts
    ? Math.max(1, parseInt(manualContracts) || 1)
    : (result?.contracts || 1);

  const displayResult = useMemo(() => {
    if (!result) return null;
    if (!manualContracts) return result;
    const n = effectiveContracts;
    const entry = parseFloat(form.entryPrice || 0);
    const lot = parseFloat(form.lot || 1);
    const commission = Math.round(entry * n * lot * parseFloat(form.commissionRate || 0.0006) * 2);
    const totalLoss = Math.round(result.lossPerContract * n + commission);
    const totalProfit = Math.round(result.profitPerContract * n - commission);
    const totalMargin = Math.round((result.totalMargin / Math.max(result.contracts, 1)) * n);
    const positionValue = Math.round(entry * n * lot);
    const deposit = parseFloat(form.depositSize) || 1;
    const marginUsed = instrumentType === 'future' ? totalMargin : positionValue;
    return {
      ...result,
      contracts: n,
      commission,
      totalLoss,
      totalProfit,
      totalMargin,
      positionValue,
      marginUsagePercent: Math.round((marginUsed / deposit) * 100),
      maxMarginPercent: result.maxMarginPercent || 30,
    };
  }, [result, manualContracts, effectiveContracts, form, instrumentType]);

  const rrColor = !displayResult ? '' : displayResult.rr >= 2 ? 'var(--green)' : displayResult.rr >= 1 ? 'var(--gold)' : 'var(--red)';

  const loadInstrument = useCallback(async () => {
    if (!tapi || !form.ticker) {
      toast.error('Введите тикер и API-токен в настройках');
      return;
    }
    setLoadingPrice(true);
    try {
      const raw = instrumentType === 'stock'
        ? await tapi.getShareByTicker(form.ticker.toUpperCase())
        : await tapi.getFutureByTicker(form.ticker.toUpperCase());
      if (!raw) { toast.error(`Инструмент ${form.ticker.toUpperCase()} не найден`); return; }
      const info = instrumentType === 'stock' ? parseShareInfo(raw) : parseFutureInfo(raw);
      setInstrumentInfo(info);
      const price = await tapi.getLastPrice(info.figi);
      const fmtNum = (n) => n ? String(n).replace(',', '.') : '';
      setForm(f => ({
        ...f,
        entryPrice: price ? String(price) : f.entryPrice,
        lot: String(info.lot || 1),
        minStep: fmtNum(info.minPriceIncrement) || '1',
        minStepAmount: fmtNum(info.minPriceIncrementAmount) || '',
        initialMargin: fmtNum(info.initialMargin) || '',
      }));
      if (price) toast.success(`${info.ticker}: ${price} ₽`);
    } catch (e) {
      toast.error('Ошибка: ' + e.message);
    } finally {
      setLoadingPrice(false);
    }
  }, [tapi, form.ticker, instrumentType]);

  useEffect(() => {
    if (!tapi || !instrumentInfo?.figi) return;
    const interval = setInterval(async () => {
      try {
        const price = await tapi.getLastPrice(instrumentInfo.figi);
        if (price) setForm(f => ({ ...f, entryPrice: String(price) }));
      } catch {}
    }, 30000);
    return () => clearInterval(interval);
  }, [tapi, instrumentInfo]);

  return (
    <div className="page">
      <style>{`
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        .btn-ai-hover { transition: transform 0.2s, box-shadow 0.2s; }
        .btn-ai-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(124,58,237,0.4); }
      `}</style>

      <div className="page-header">
        <h1 className="page-title">🧮 Калькулятор сделки</h1>
        <p className="page-subtitle">Автоматический расчёт параметров позиции</p>
      </div>

      <div style={{display:'flex', gap:8, marginBottom:24}}>
        {[['future','⚡ Фьючерс'],['stock','📈 Акция']].map(([val, label]) => (
          <button key={val}
            className={val === instrumentType ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => {
              setInstrumentType(val);
              setManualContracts('');
              setInstrumentInfo(null);
              setForm(f => ({ ...f, ticker:'', entryPrice:'', stopLoss:'', takeProfit:'', initialMargin:'', minStep:'1', minStepAmount:'', lot:'1' }));
            }}
          >{label}</button>
        ))}
      </div>

      <div className="calc-layout">
        {/* Левая колонка — форма в одной карточке */}
        <div className="calc-input-panel">
          <div className="card">
            {/* Инструмент */}
            <div className="calc-section-title">Инструмент</div>
            <div className="input-group" style={{marginBottom:12}}>
              <label className="input-label">Тикер</label>
              <div style={{display:'flex', gap:8}}>
                <input className="input" value={form.ticker}
                  onChange={e => set('ticker', e.target.value.toUpperCase())}
                  placeholder={instrumentType === 'future' ? 'SRZ6, IMOEXF...' : 'VTBR, SBER...'}
                  style={{flex:1}} />
                <button className="btn btn-secondary" onClick={loadInstrument} disabled={loadingPrice} style={{whiteSpace:'nowrap'}}>
                  {loadingPrice ? <div className="spinner" style={{width:14,height:14}}/> : '🔄'} Загрузить
                </button>
              </div>
            </div>
            {instrumentInfo && (
              <div className="instrument-info">
                <span className="badge badge-purple">{instrumentInfo.ticker}</span>
                <span className="text-sm text-secondary">{instrumentInfo.name}</span>
                {instrumentInfo.isShare
                  ? <span className="text-xs text-muted">📈 Акция MOEX</span>
                  : instrumentInfo.expirationDate && (
                    <span className="text-xs text-muted">
                      Экспирация: {new Date(instrumentInfo.expirationDate).toLocaleDateString('ru-RU')}
                    </span>
                  )
                }
                <span className="text-xs" style={{color:'var(--green)'}}>🔄 авто 30с</span>
              </div>
            )}

            <div className="divider" />

            {/* Направление */}
            <div className="calc-section-title">Направление</div>
            <div style={{display:'flex', gap:8, marginBottom:16}}>
              {['Лонг','Шорт'].map(d => (
                <button key={d}
                  className={result?.direction === d.toLowerCase() ? 'btn btn-primary' : 'btn btn-secondary'}
                  style={{flex:1}}
                  onClick={() => {
                    if (d === 'Лонг' && parseFloat(form.stopLoss) > parseFloat(form.entryPrice)) set('stopLoss','');
                    if (d === 'Шорт' && parseFloat(form.stopLoss) < parseFloat(form.entryPrice)) set('stopLoss','');
                  }}
                >{d === 'Лонг' ? '✅' : '🔽'} {d}</button>
              ))}
            </div>

            <div className="divider" />

            {/* Цены */}
            <div className="calc-section-title">Цены</div>
            <div className="calc-grid-2" style={{marginBottom:12}}>
              <div className="input-group">
                <label className="input-label">Цена входа</label>
                <input className="input" type="number" value={form.entryPrice} onChange={e => set('entryPrice', e.target.value)} placeholder="0" />
              </div>
              <div className="input-group">
                <label className="input-label">Стоп-лосс</label>
                <input className="input" type="number" value={form.stopLoss} onChange={e => set('stopLoss', e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="input-group" style={{marginBottom:16}}>
              <label className="input-label">Тейк-профит <span style={{color:'var(--text-muted)'}}>(опц.)</span></label>
              <input className="input" type="number" value={form.takeProfit} onChange={e => set('takeProfit', e.target.value)} placeholder="0 (опц.)" />
            </div>

            <div className="divider" />

            {/* Управление риском */}
            <div className="calc-section-title">Управление риском</div>
            <div className="calc-grid-2" style={{marginBottom:16}}>
              <div className="input-group">
                <label className="input-label">Депозит (₽)</label>
                <input className="input" type="number" value={form.depositSize} onChange={e => set('depositSize', e.target.value)} />
              </div>
              <div className="input-group">
                <label className="input-label">Риск на сделку (%)</label>
                <div className="input-prefix">
                  <span className="input-prefix-text">%</span>
                  <input className="input" type="number" value={form.riskPercent} onChange={e => set('riskPercent', e.target.value)} placeholder="1" />
                </div>
              </div>
            </div>

            <div className="divider" />

            {/* Параметры контракта */}
            <div className="calc-section-title">Параметры контракта</div>
            <div className="calc-grid-2" style={{marginBottom: instrumentType === 'future' ? 12 : 0}}>
              <div className="input-group">
                <label className="input-label">Лот (лотность)</label>
                <input className="input" type="number" value={form.lot} onChange={e => set('lot', e.target.value)} placeholder="1" />
              </div>
              {instrumentType === 'future' && (
                <div className="input-group">
                  <label className="input-label">ГО (₽ на контракт)</label>
                  <input className="input" type="number" value={form.initialMargin} onChange={e => set('initialMargin', e.target.value)} placeholder="авто" />
                </div>
              )}
            </div>
            {instrumentType === 'future' && (
              <div className="calc-grid-2" style={{marginBottom:12}}>
                <div className="input-group">
                  <label className="input-label">Шаг цены</label>
                  <input className="input" type="number" value={form.minStep} onChange={e => set('minStep', e.target.value)} placeholder="1" />
                </div>
                <div className="input-group">
                  <label className="input-label">Стоимость шага (₽)</label>
                  <input className="input" type="number" value={form.minStepAmount} onChange={e => set('minStepAmount', e.target.value)} placeholder="авто" />
                </div>
              </div>
            )}
            <div className="input-group">
              <label className="input-label">Комиссия (0.0006 = 0.06%)</label>
              <input className="input" type="number" value={form.commissionRate} onChange={e => set('commissionRate', e.target.value)} placeholder="0.0006" />
            </div>
          </div>
        </div>

        {/* Правая колонка — результаты */}
        <div className="calc-results-panel">
          {result && displayResult && result.contracts > 0 ? (
            <>
              {/* 3 карточки метрик */}
              <div className="calc-key-metrics">
                {/* Контракты */}
                <div className={`calc-metric-card ${displayResult.direction === 'long' ? 'green' : 'red'}`}>
                  <div className="calc-metric-label">{instrumentType === 'stock' ? 'Лотов' : 'Контрактов'}</div>
                  <div style={{
                    display:'flex', alignItems:'center', gap:6,
                    background:'rgba(255,255,255,0.07)',
                    border: manualContracts ? '1px solid var(--gold)' : '1px solid rgba(255,255,255,0.12)',
                    borderRadius:10, padding:'6px 10px', marginBottom:8,
                  }}>
                    <input
                      type="number" min="1"
                      value={manualContracts}
                      onChange={e => setManualContracts(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      placeholder="Введите..."
                      style={{
                        flex:1, background:'none', border:'none', outline:'none',
                        fontFamily:'inherit', fontSize:16, fontWeight:700,
                        color: manualContracts ? 'var(--gold)' : 'var(--text-primary)',
                        padding:0, width:'60px',
                        MozAppearance:'textfield', WebkitAppearance:'none',
                        pointerEvents:'all', cursor:'text',
                      }}
                    />
                    <span style={{fontSize:11, color:'var(--text-muted)'}}>шт.</span>
                    {manualContracts && (
                      <button onClick={() => setManualContracts('')} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',fontSize:13,padding:0}}>✕</button>
                    )}
                  </div>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',background:'rgba(255,255,255,0.04)',borderRadius:8,padding:'4px 10px'}}>
                    <span style={{fontSize:11,color:'var(--text-muted)'}}>авто:</span>
                    <span style={{fontSize:20,fontWeight:800,color:manualContracts?'var(--text-muted)':'var(--text-primary)'}}>{result.contracts}</span>
                    <span style={{fontSize:11,color:'var(--text-muted)'}}>шт.</span>
                  </div>
                </div>

                {/* RR */}
                <div className={`calc-metric-card ${!displayResult.rrValid && displayResult.rr !== 0 ? 'red' : displayResult.rr >= 2 ? 'green' : displayResult.rr >= 1 ? 'gold' : 'red'}`}>
                  <div className="calc-metric-label">RISK/REWARD</div>
                  <div style={{fontSize:28,fontWeight:800,color:rrColor}}>
                    {displayResult.rr > 0 ? `1:${formatNumber(displayResult.rr, 1)}` : '—'}
                  </div>
                  {!displayResult.rrValid && displayResult.rr !== 0
                    ? <div style={{fontSize:11,color:'var(--red)'}}>⚠️ TP не там!</div>
                    : displayResult.rr >= 2
                    ? <div style={{fontSize:11,color:'var(--green)'}}>✅ Отличный</div>
                    : displayResult.rr >= 1
                    ? <div style={{fontSize:11,color:'var(--gold)'}}>🟡 Приемлемый</div>
                    : null
                  }
                </div>

                {/* ГО */}
                <div className={`calc-metric-card ${(displayResult.marginUsagePercent||0) > (displayResult.maxMarginPercent||30) ? 'red' : 'blue'}`}>
                  <div className="calc-metric-label">{instrumentType==='stock' ? 'СТОИМОСТЬ ПОЗИЦИИ' : 'ГО (ЗАМОРОЗКА)'}</div>
                  <div style={{fontSize:20,fontWeight:800}}>
                    {formatCurrency(instrumentType==='stock' ? displayResult.positionValue : displayResult.totalMargin)}
                  </div>
                  <div style={{fontSize:11,color:(displayResult.marginUsagePercent||0)>(displayResult.maxMarginPercent||30)?'var(--red)':''}}>
                    {displayResult.marginUsagePercent||0}% / лимит {displayResult.maxMarginPercent||30}%
                  </div>
                  <div className="divider" style={{margin:'6px 0'}}/>
                  <div style={{fontSize:11,color:'var(--text-muted)'}}>Стоимость позиции:</div>
                  <div style={{fontSize:13,fontWeight:700}}>{formatCurrency(displayResult.positionValue)}</div>
                </div>
              </div>

              {/* Кнопки */}
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                <button className="btn btn-primary" style={{flex:1}}>📂 В журнал</button>
                <button className="btn btn-ai-hover" style={{flex:1,background:'linear-gradient(135deg,#7c3aed,#4f46e5)',color:'#fff',border:'none',borderRadius:12,fontWeight:600,fontSize:14}}
                  onClick={() => {
                    const p = new URLSearchParams({
                      from:'calculator', ticker:form.ticker||'', name:instrumentInfo?.name||'',
                      direction:displayResult.direction||'', entry:form.entryPrice||'',
                      sl:form.stopLoss||'', tp:form.takeProfit||'',
                      contracts:String(effectiveContracts), rr:String(displayResult.rr||''),
                      riskAmount:String(displayResult.riskAmount||''), totalLoss:String(displayResult.totalLoss||''),
                      totalProfit:String(displayResult.totalProfit||''), commission:String(displayResult.commission||''),
                      breakeven:String(displayResult.breakeven||''), deposit:form.depositSize||'', type:instrumentType,
                    });
                    window.location.href = '/advisor?' + p.toString();
                  }}
                >🤖 В AI</button>
              </div>

              {/* Детализация */}
              <div className="card">
                <div className="section-title">
                  <div className="section-title-icon">📋</div>
                  Детализация
                </div>
                <ResultRow label="Риск на сделку" value={formatCurrency(displayResult.riskAmount)} color="var(--red)" />
                <ResultRow label="Тиков до SL" value={formatNumber(displayResult.ticksToSL)} />
                <ResultRow label="Тиков до TP" value={displayResult.ticksToTP > 0 ? formatNumber(displayResult.ticksToTP) : '—'} />
                <ResultRow label="Убыток на контракт" value={formatCurrency(displayResult.lossPerContract)} color="var(--red)" />
                <ResultRow label="Прибыль на контракт" value={displayResult.profitPerContract > 0 ? formatCurrency(displayResult.profitPerContract) : '—'} color="var(--green)" />
                <ResultRow label="Комиссия" value={formatCurrency(displayResult.commission)} />
                <ResultRow label="Точка безубытка" value={formatNumber(displayResult.breakeven, 2)} />
                <div className="divider" />
                <ResultRow label="Макс. убыток (с комис.)" value={formatCurrency(displayResult.totalLoss)} color="var(--red)" large />
                {displayResult.totalProfit > 0 && (
                  <ResultRow label="Потенц. прибыль (с комис.)" value={formatCurrency(displayResult.totalProfit)} color="var(--green)" large />
                )}
              </div>

              {/* Прогресс-бар */}
              <div className="card">
                <div className="section-title">
                  <div className="section-title-icon">⚡</div>
                  Использование капитала
                </div>
                <div className="risk-gauge-bar">
                  <div className="risk-gauge-fill" style={{
                    width:`${Math.min(displayResult.marginUsagePercent||0,100)}%`,
                    background:(displayResult.marginUsagePercent||0)>50
                      ?'linear-gradient(90deg,#f59e0b,#ef4444)'
                      :(displayResult.marginUsagePercent||0)>25
                      ?'linear-gradient(90deg,#4f46e5,#f59e0b)'
                      :'linear-gradient(90deg,#4f46e5,#10b981)',
                  }}/>
                </div>
                <div className="risk-gauge-labels">
                  <span className="text-sm text-secondary">
                    {instrumentType==='stock'?'Позиция':'ГО'}: {formatCurrency(instrumentType==='stock'?displayResult.positionValue:displayResult.totalMargin)}
                  </span>
                  <span style={{fontWeight:700,fontSize:14,color:(displayResult.marginUsagePercent||0)>50?'var(--red)':'var(--text-primary)'}}>
                    {displayResult.marginUsagePercent||0}%
                  </span>
                </div>
                <div className="text-xs text-muted" style={{marginTop:6,color:(displayResult.marginUsagePercent||0)>70?'var(--gold)':(displayResult.marginUsagePercent||0)>40?'var(--gold)':'var(--green)'}}>
                  {(displayResult.marginUsagePercent||0)>70?'⚠️ Высокая загрузка — рискованно':(displayResult.marginUsagePercent||0)>40?'🟡 Умеренная загрузка':'✅ Нормальная загрузка'}
                </div>
              </div>
            </>
          ) : (
            <div className="card" style={{textAlign:'center',padding:'48px 24px'}}>
              <div className="empty-state">
                <div className="empty-state-icon">🧮</div>
                <div className="empty-state-title">Введите параметры</div>
                <div className="empty-state-text">Введите цену входа, стоп-лосс, размер депозита и риск — результат появится автоматически</div>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
