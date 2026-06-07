// src/components/calculator/Calculator.js
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { TinkoffAPI, parseFutureInfo, parseShareInfo } from '../../services/tinkoff';
import { calcTrade, formatCurrency, formatNumber } from '../../utils/calculator';
import { addTrade } from '../../services/trades';
import toast from 'react-hot-toast';
import './Calculator.css';

// MOEX API — бесплатные цены без токена
async function getMoexPrice(ticker, type) {
  try {
    const board = type === 'future' ? 'SPBFUT' : 'TQBR';
    const market = type === 'future' ? 'forts' : 'shares';
    const engine = type === 'future' ? 'futures' : 'stock';
    const url = `https://iss.moex.com/iss/engines/${engine}/markets/${market}/boards/${board}/securities/${ticker}.json?iss.meta=off&iss.only=marketdata&marketdata.columns=LAST,LASTTOPREVPRICE`;
    const res = await fetch(url);
    const data = await res.json();
    const price = data?.marketdata?.data?.[0]?.[0];
    return price ? parseFloat(price) : null;
  } catch { return null; }
}

const EMOTIONS = ['😊 Спокойный', '😤 Уверенный', '😰 Тревожный', '😴 Усталый', '😡 Злой', '🤔 Сомневающийся'];

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
  const [instrumentType, setInstrumentType] = useState('future');
  const [priceSource, setPriceSource] = useState('tinkoff'); // 'tinkoff' | 'moex'
  const [orderType, setOrderType] = useState('market'); // 'market' | 'limit'
  const [manualContracts, setManualContracts] = useState('');
  const [journalAnim, setJournalAnim] = useState(false);
  const [showJournalModal, setShowJournalModal] = useState(false);
  const [journalExtra, setJournalExtra] = useState({ setup: '', emotion: '', notes: '' });
  const [savingTrade, setSavingTrade] = useState(false);
  const [forcedDir, setForcedDir] = useState(null);

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

  // Умное направление
  const activeDirection = (() => {
    const sl = parseFloat(form.stopLoss);
    const entry = parseFloat(form.entryPrice);
    if (sl && entry) return sl < entry ? 'long' : 'short';
    return forcedDir;
  })();

  const rrColor = !displayResult ? '' : displayResult.rr >= 2 ? 'var(--green)' : displayResult.rr >= 1 ? 'var(--gold)' : 'var(--red)';

  const loadInstrument = useCallback(async () => {
    if (!form.ticker) { toast.error('Введите тикер'); return; }

    setLoadingPrice(true);
    try {
      if (priceSource === 'moex') {
        // MOEX — только цена, параметры вручную
        const price = await getMoexPrice(form.ticker.toUpperCase(), instrumentType);
        if (!price) { toast.error('Инструмент не найден на MOEX'); return; }
        if (orderType === 'market') set('entryPrice', String(price));
        toast.success(`${form.ticker.toUpperCase()}: ${price} ₽ (MOEX, задержка 15 мин)`);
      } else {
        // Тинькофф
        if (!tapi) { toast.error('Введите API-токен в настройках'); return; }
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
          entryPrice: (orderType === 'market' && price) ? String(price) : f.entryPrice,
          lot: String(info.lot || 1),
          minStep: fmtNum(info.minPriceIncrement) || '1',
          minStepAmount: fmtNum(info.minPriceIncrementAmount) || '',
          initialMargin: fmtNum(info.initialMargin) || '',
        }));
        if (price) toast.success(`${info.ticker}: ${price} ₽`);
      }
    } catch (e) {
      toast.error('Ошибка: ' + e.message);
    } finally {
      setLoadingPrice(false);
    }
  }, [tapi, form.ticker, instrumentType, priceSource, orderType]);

  // Автообновление (только Тинькофф + рыночная)
  useEffect(() => {
    if (!tapi || !instrumentInfo?.figi || priceSource !== 'tinkoff' || orderType !== 'market') return;
    const interval = setInterval(async () => {
      try {
        const price = await tapi.getLastPrice(instrumentInfo.figi);
        if (price) setForm(f => ({ ...f, entryPrice: String(price) }));
      } catch {}
    }, 30000);
    return () => clearInterval(interval);
  }, [tapi, instrumentInfo, priceSource, orderType]);

  // Сохранение в журнал
  const handleSaveToJournal = async () => {
    if (!user || !displayResult) return;
    setSavingTrade(true);
    try {
      const deposit = parseFloat(form.depositSize) || 0;
      await addTrade(user.uid, {
        ticker: form.ticker || instrumentInfo?.ticker || '',
        date: new Date().toISOString().split('T')[0],
        status: 'open',
        direction: activeDirection || displayResult.direction,
        entryPrice: parseFloat(form.entryPrice),
        exitPrice: null,
        stopLoss: parseFloat(form.stopLoss) || null,
        takeProfit: parseFloat(form.takeProfit) || null,
        volume: effectiveContracts,
        lot: parseFloat(form.lot) || 1,
        commission: displayResult.commission,
        depositSize: deposit,
        depositPercent: deposit > 0 ? Math.round((displayResult.riskAmount / deposit) * 100 * 10) / 10 : 0,
        rr: displayResult.rr,
        pnl: null,
        setup: journalExtra.setup,
        emotion: journalExtra.emotion,
        notes: journalExtra.notes,
        source: 'calculator',
        orderType,
      });
      toast.success('✅ Сделка открыта в журнале');
      setShowJournalModal(false);
      setJournalExtra({ setup: '', emotion: '', notes: '' });
    } catch (e) {
      toast.error('Ошибка сохранения: ' + e.message);
    } finally {
      setSavingTrade(false);
    }
  };

  const handleJournalClick = () => {
    // Анимация
    setJournalAnim(true);
    setTimeout(() => setJournalAnim(false), 700);
    // Если настройка "запрашивать" включена (по умолчанию) — модалка
    if (userProfile?.askJournalExtra === true) {
      setShowJournalModal(true);
    } else {
      handleSaveToJournal();
    }
  };

  return (
    <div className="page">
      <style>{`
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        .btn-ai-hover { transition: transform 0.2s, box-shadow 0.2s; }
        .btn-ai-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(124,58,237,0.4); }
        @keyframes flyToJournal {
          0%   { transform: scale(1) translate(0, 0); opacity: 1; }
          30%  { transform: scale(1.3) translate(-5px, -8px); opacity: 1; }
          100% { transform: scale(0.2) translate(-120px, 40px); opacity: 0; }
        }
        .journal-fly { animation: flyToJournal 0.7s cubic-bezier(0.4, 0, 0.2, 1) forwards; display:inline-block; }
        .calc-modal-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:flex-end;justify-content:center;padding:20px; }
        .calc-modal { background:var(--bg-surface);border:1px solid var(--border-medium);border-radius:24px 24px 20px 20px;padding:28px;width:100%;max-width:520px;animation:slideUp 0.3s cubic-bezier(0.16,1,0.3,1); }
        @keyframes slideUp { from{transform:translateY(40px);opacity:0} to{transform:translateY(0);opacity:1} }
      `}</style>

      <div className="page-header">
        <h1 className="page-title">🧮 Калькулятор сделки</h1>
        <p className="page-subtitle">Автоматический расчёт параметров позиции</p>
      </div>

      {/* Тип инструмента */}
      <div style={{display:'flex', gap:8, marginBottom:16, flexWrap:'wrap'}}>
        {[['future','⚡ Фьючерс'],['stock','📈 Акция']].map(([val, label]) => (
          <button key={val}
            className={val === instrumentType ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => {
              setInstrumentType(val);
              setManualContracts('');
              setInstrumentInfo(null);
              setForcedDir(null);
              setForm(f => ({ ...f, ticker:'', entryPrice:'', stopLoss:'', takeProfit:'', initialMargin:'', minStep:'1', minStepAmount:'', lot:'1' }));
            }}
          >{label}</button>
        ))}

        {/* Разделитель */}
        <div style={{width:1, background:'var(--border-subtle)', margin:'0 4px'}}/>

        {/* Источник цены */}
        {[['tinkoff','🏦 Тинькофф'],['moex','📡 MOEX']].map(([val, label]) => (
          <button key={val}
            className={val === priceSource ? 'btn btn-secondary' : 'btn btn-ghost'}
            style={{fontSize:13, border: val === priceSource ? '1px solid var(--accent-primary)' : undefined, color: val === priceSource ? 'var(--accent-primary)' : undefined}}
            onClick={() => {
              setPriceSource(val);
              if (val === 'moex') {
                setOrderType('limit');
                set('entryPrice', '');
              }
            }}
          >{label}</button>
        ))}
      </div>

      {priceSource === 'moex' && (
        <div style={{background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.3)',borderRadius:10,padding:'8px 14px',marginBottom:16,fontSize:12,color:'var(--gold)'}}>
          ⚠️ MOEX: данные с задержкой ~15 минут. Параметры контракта (ГО, шаг цены) вводятся вручную. Работает без токена Тинькофф.
        </div>
      )}

      <div className="calc-layout">
        <div className="calc-input-panel">
          <div className="card">
            {/* Инструмент */}
            <div className="calc-section-title">Инструмент</div>
            <div className="input-group" style={{marginBottom:12}}>
              <label className="input-label">Тикер</label>
              <div style={{display:'flex', gap:8}}>
                <input className="input" value={form.ticker}
                  onChange={e => set('ticker', e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && loadInstrument()}
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
                {priceSource === 'tinkoff' && orderType === 'market' && (
                  <span className="text-xs" style={{color:'var(--green)'}}>🔄 авто 30с</span>
                )}
              </div>
            )}

            <div className="divider" />

            {/* Тип заявки */}
            <div className="calc-section-title">Тип заявки</div>
            <div style={{display:'flex', gap:8, marginBottom:16}}>
              {[['market','По рынку'],['limit','Лимитная']].map(([val, label]) => (
                <button key={val}
                  className={val === orderType ? 'btn btn-primary' : 'btn btn-secondary'}
                  style={{flex:1, fontSize:13}}
                  onClick={() => {
                    setOrderType(val);
                    if (val === 'limit') set('entryPrice', '');
                  }}
                >{val === 'market' ? '⚡' : '🎯'} {label}</button>
              ))}
            </div>
            {orderType === 'limit' && (
              <div style={{background:'rgba(79,70,229,0.08)',border:'1px solid rgba(79,70,229,0.2)',borderRadius:10,padding:'8px 14px',marginBottom:12,fontSize:12,color:'var(--accent-primary)'}}>
                🎯 Лимитная: введите цену по которой хотите войти. Расчёт ведётся от неё.
              </div>
            )}

            <div className="divider" />

            {/* Направление */}
            <div className="calc-section-title">Направление</div>
            <div style={{display:'flex', gap:8, marginBottom:16}}>
              <button className="btn" style={{flex:1,
                background: activeDirection === 'long' ? 'linear-gradient(135deg,#10b981,#059669)' : 'var(--bg-surface-2)',
                color: activeDirection === 'long' ? '#fff' : 'var(--text-secondary)',
                border: activeDirection === 'long' ? 'none' : '1px solid var(--border-medium)',
                fontWeight:600, transition:'all 0.2s'}}
                onClick={() => setForcedDir('long')}
              >↑ Лонг</button>
              <button className="btn" style={{flex:1,
                background: activeDirection === 'short' ? 'linear-gradient(135deg,#ef4444,#dc2626)' : 'var(--bg-surface-2)',
                color: activeDirection === 'short' ? '#fff' : 'var(--text-secondary)',
                border: activeDirection === 'short' ? 'none' : '1px solid var(--border-medium)',
                fontWeight:600, transition:'all 0.2s'}}
                onClick={() => setForcedDir('short')}
              >↓ Шорт</button>
            </div>

            <div className="divider" />

            {/* Цены */}
            <div className="calc-section-title">Цены</div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:16}}>
              <div className="input-group">
                <label className="input-label">
                  {orderType === 'limit' ? '🎯 Цена заявки' : 'Цена входа'}
                </label>
                <input className="input" type="number" value={form.entryPrice}
                  onChange={e => set('entryPrice', e.target.value)}
                  placeholder={orderType === 'limit' ? 'Ваша цена' : '0'}
                  style={{borderColor: orderType === 'limit' ? 'rgba(79,70,229,0.5)' : undefined}} />
              </div>
              <div className="input-group">
                <label className="input-label">Стоп-лосс</label>
                <input className="input" type="number" value={form.stopLoss} onChange={e => set('stopLoss', e.target.value)} placeholder="0" />
              </div>
              <div className="input-group">
                <label className="input-label">Тейк-профит <span style={{color:'var(--text-muted)',fontSize:10}}>(опц.)</span></label>
                <input className="input" type="number" value={form.takeProfit} onChange={e => set('takeProfit', e.target.value)} placeholder="0" />
              </div>
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

        {/* Правая колонка */}
        <div className="calc-results-panel">
          {result && displayResult && result.contracts > 0 ? (
            <>
              <div className="calc-key-metrics">
                {/* Контракты */}
                <div className={`calc-metric-card ${displayResult.direction === 'long' ? 'green' : 'red'}`}>
                  <div className="calc-metric-label">{instrumentType === 'stock' ? 'Лотов' : 'Контрактов'}</div>
                  <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.07)',border:manualContracts?'1px solid var(--gold)':'1px solid rgba(255,255,255,0.12)',borderRadius:10,padding:'6px 10px',marginBottom:8,position:'relative',zIndex:10}}>
                    <input type="number" min="1" value={manualContracts}
                      onChange={e => setManualContracts(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      placeholder="Введите..."
                      style={{flex:1,background:'none',border:'none',outline:'none',fontFamily:'inherit',fontSize:16,fontWeight:700,color:manualContracts?'var(--gold)':'var(--text-primary)',padding:0,width:'60px',MozAppearance:'textfield',WebkitAppearance:'none',pointerEvents:'all',cursor:'text',position:'relative',zIndex:10}}
                    />
                    <span style={{fontSize:11,color:'var(--text-muted)'}}>шт.</span>
                    {manualContracts && <button onClick={() => setManualContracts('')} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',fontSize:13,padding:0}}>✕</button>}
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
                  <div style={{fontSize:28,fontWeight:800,color:rrColor}}>{displayResult.rr > 0 ? `1:${formatNumber(displayResult.rr, 1)}` : '—'}</div>
                  {!displayResult.rrValid && displayResult.rr !== 0 ? <div style={{fontSize:11,color:'var(--red)'}}>⚠️ TP не там!</div>
                    : displayResult.rr >= 2 ? <div style={{fontSize:11,color:'var(--green)'}}>✅ Отличный</div>
                    : displayResult.rr >= 1 ? <div style={{fontSize:11,color:'var(--gold)'}}>🟡 Приемлемый</div>
                    : null}
                </div>

                {/* ГО */}
                <div className={`calc-metric-card ${(displayResult.marginUsagePercent||0) > (displayResult.maxMarginPercent||30) ? 'red' : 'blue'}`}>
                  <div className="calc-metric-label">{instrumentType==='stock' ? 'СТОИМОСТЬ ПОЗИЦИИ' : 'ГО (ЗАМОРОЗКА)'}</div>
                  <div style={{fontSize:20,fontWeight:800}}>{formatCurrency(instrumentType==='stock' ? displayResult.positionValue : displayResult.totalMargin)}</div>
                  <div style={{fontSize:11,color:(displayResult.marginUsagePercent||0)>(displayResult.maxMarginPercent||30)?'var(--red)':''}}>{displayResult.marginUsagePercent||0}% / лимит {displayResult.maxMarginPercent||30}%</div>
                  <div className="divider" style={{margin:'6px 0'}}/>
                  <div style={{fontSize:11,color:'var(--text-muted)'}}>Стоимость позиции:</div>
                  <div style={{fontSize:13,fontWeight:700}}>{formatCurrency(displayResult.positionValue)}</div>
                </div>
              </div>

              {/* Кнопки */}
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                <button className="btn btn-primary" style={{flex:1, overflow:'hidden'}} onClick={handleJournalClick}>
                  <span className={journalAnim ? 'journal-fly' : ''} style={{marginRight:4}}>📂</span>В журнал
                </button>
                <button className="btn btn-ai-hover" style={{flex:1,background:'linear-gradient(135deg,#7c3aed,#4f46e5)',color:'#fff',border:'none',borderRadius:12,fontWeight:600,fontSize:14}}
                  onClick={() => {
                    const p = new URLSearchParams({from:'calculator',ticker:form.ticker||'',name:instrumentInfo?.name||'',direction:displayResult.direction||'',entry:form.entryPrice||'',sl:form.stopLoss||'',tp:form.takeProfit||'',contracts:String(effectiveContracts),rr:String(displayResult.rr||''),riskAmount:String(displayResult.riskAmount||''),totalLoss:String(displayResult.totalLoss||''),totalProfit:String(displayResult.totalProfit||''),commission:String(displayResult.commission||''),breakeven:String(displayResult.breakeven||''),deposit:form.depositSize||'',type:instrumentType});
                    window.location.href = '/advisor?' + p.toString();
                  }}
                >🤖 В AI</button>
              </div>

              {/* Детализация */}
              <div className="card">
                <div className="section-title"><div className="section-title-icon">📋</div>Детализация</div>
                <ResultRow label="Риск на сделку" value={formatCurrency(displayResult.riskAmount)} color="var(--red)" />
                <ResultRow label="Тиков до SL" value={formatNumber(displayResult.ticksToSL)} />
                <ResultRow label="Тиков до TP" value={displayResult.ticksToTP > 0 ? formatNumber(displayResult.ticksToTP) : '—'} />
                <ResultRow label="Убыток на контракт" value={formatCurrency(displayResult.lossPerContract)} color="var(--red)" />
                <ResultRow label="Прибыль на контракт" value={displayResult.profitPerContract > 0 ? formatCurrency(displayResult.profitPerContract) : '—'} color="var(--green)" />
                <ResultRow label="Комиссия" value={formatCurrency(displayResult.commission)} />
                <ResultRow label="Точка безубытка" value={formatNumber(displayResult.breakeven, 2)} />
                <div className="divider" />
                <ResultRow label="Макс. убыток (с комис.)" value={formatCurrency(displayResult.totalLoss)} color="var(--red)" large />
                {displayResult.totalProfit > 0 && <ResultRow label="Потенц. прибыль (с комис.)" value={formatCurrency(displayResult.totalProfit)} color="var(--green)" large />}
              </div>

              {/* Прогресс-бар */}
              <div className="card">
                <div className="section-title"><div className="section-title-icon">⚡</div>Использование капитала</div>
                <div className="risk-gauge-bar">
                  <div className="risk-gauge-fill" style={{width:`${Math.min(displayResult.marginUsagePercent||0,100)}%`,background:(displayResult.marginUsagePercent||0)>50?'linear-gradient(90deg,#f59e0b,#ef4444)':(displayResult.marginUsagePercent||0)>25?'linear-gradient(90deg,#4f46e5,#f59e0b)':'linear-gradient(90deg,#4f46e5,#10b981)'}}/>
                </div>
                <div className="risk-gauge-labels">
                  <span className="text-sm text-secondary">{instrumentType==='stock'?'Позиция':'ГО'}: {formatCurrency(instrumentType==='stock'?displayResult.positionValue:displayResult.totalMargin)}</span>
                  <span style={{fontWeight:700,fontSize:14,color:(displayResult.marginUsagePercent||0)>50?'var(--red)':'var(--text-primary)'}}>{displayResult.marginUsagePercent||0}%</span>
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

      {/* Модалка "В журнал" */}
      {showJournalModal && (
        <div className="calc-modal-overlay" onClick={() => setShowJournalModal(false)}>
          <div className="calc-modal" onClick={e => e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
              <div>
                <div style={{fontSize:18,fontWeight:700,color:'var(--text-primary)'}}>📂 Открыть сделку</div>
                <div style={{fontSize:13,color:'var(--text-muted)',marginTop:2}}>
                  {form.ticker} · {activeDirection === 'long' ? '↑ Лонг' : '↓ Шорт'} · {form.entryPrice} ₽ · {effectiveContracts} шт.
                </div>
              </div>
              <button onClick={() => setShowJournalModal(false)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',fontSize:20}}>✕</button>
            </div>

            <div className="flex flex-col gap-3">
              <div className="input-group">
                <label className="input-label">Сетап / стратегия</label>
                <input className="input" value={journalExtra.setup}
                  onChange={e => setJournalExtra(p => ({...p, setup: e.target.value}))}
                  placeholder="Пробой уровня, откат к MA..." />
              </div>

              <div className="input-group">
                <label className="input-label">Эмоциональное состояние</label>
                <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  {EMOTIONS.map(e => (
                    <button key={e}
                      style={{padding:'6px 12px',borderRadius:20,border:'1px solid var(--border-subtle)',background:journalExtra.emotion===e?'rgba(79,70,229,0.2)':'var(--bg-surface-2)',color:journalExtra.emotion===e?'var(--accent-primary)':'var(--text-secondary)',cursor:'pointer',fontSize:12,fontFamily:'inherit',transition:'all 0.15s'}}
                      onClick={() => setJournalExtra(p => ({...p, emotion: p.emotion === e ? '' : e}))}
                    >{e}</button>
                  ))}
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Заметки</label>
                <textarea className="input" value={journalExtra.notes}
                  onChange={e => setJournalExtra(p => ({...p, notes: e.target.value}))}
                  placeholder="Что ожидаю от сделки..."
                  rows={3} style={{resize:'vertical'}} />
              </div>
            </div>

            <div style={{display:'flex',gap:8,marginTop:20}}>
              <button className="btn btn-secondary" style={{flex:1}} onClick={() => { setJournalExtra({setup:'',emotion:'',notes:''}); handleSaveToJournal(); }}>
                Пропустить и сохранить
              </button>
              <button className="btn btn-primary" style={{flex:1}} onClick={handleSaveToJournal} disabled={savingTrade}>
                {savingTrade ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : '✅ Открыть сделку'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
