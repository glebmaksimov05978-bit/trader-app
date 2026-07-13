// src/components/calculator/Calculator.js
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { TinkoffAPI, parseFutureInfo, parseShareInfo } from '../../services/tinkoff';
import { calcTrade, formatCurrency, formatNumber } from '../../utils/calculator';
import { addTrade } from '../../services/trades';
import { fetchDailyCandles, availableTimeframes, DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../services/marketData/candles';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { fetchActiveFutureCard, fetchMoexSecurityInfo } from '../../services/marketData/futuresSpecs';
import { evaluateStrategy } from '../../services/analytics/strategy';
import TechnicalAnalysisBlock, { PATTERN_LABELS } from '../shared/TechnicalAnalysisBlock';
import StrategyChecklist from '../shared/StrategyChecklist';
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

function toLocalDatetimeInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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

// The Calculator unmounts on every route change — without a draft the trader loses a
// half-filled trade plan just by glancing at the Journal (real user report). Session
// storage (not local) is deliberate: a draft should survive navigation, not a browser
// restart days later with stale prices.
const CALC_DRAFT_KEY = 'traderpro-calculator-draft';
function loadCalcDraft() {
  try { return JSON.parse(sessionStorage.getItem(CALC_DRAFT_KEY)) || null; } catch { return null; }
}

export default function Calculator() {
  const { user, userProfile } = useAuth();
  const draft = useRef(loadCalcDraft()).current;
  const [instrumentType, setInstrumentType] = useState(draft?.instrumentType || 'future');
  const [priceSource, setPriceSource] = useState(draft?.priceSource || 'tinkoff'); // 'tinkoff' | 'moex'
  const [orderType, setOrderType] = useState(draft?.orderType || 'market'); // 'market' | 'limit'
  const [manualContracts, setManualContracts] = useState(draft?.manualContracts || '');
  const [journalAnim, setJournalAnim] = useState(false);
  const [showJournalModal, setShowJournalModal] = useState(false);
  const [showTinkoffModal, setShowTinkoffModal] = useState(false);
  const [tinkoffCopied, setTinkoffCopied] = useState('');
  const [journalExtra, setJournalExtra] = useState({ setup: '', emotion: '', notes: '' });
  const [savingTrade, setSavingTrade] = useState(false);
  const [forcedDir, setForcedDir] = useState(draft?.forcedDir || null);
  const [openedAt, setOpenedAt] = useState(() => toLocalDatetimeInput(new Date()));

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
    ...(draft?.form || {}),
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(CALC_DRAFT_KEY, JSON.stringify({ form, instrumentType, priceSource, orderType, manualContracts, forcedDir }));
    } catch { /* private mode/quota — черновик просто не сохранится */ }
  }, [form, instrumentType, priceSource, orderType, manualContracts, forcedDir]);
  const [result, setResult] = useState(null);
  const [instrumentInfo, setInstrumentInfo] = useState(null);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [tapi, setTapi] = useState(null);
  const [taOpen, setTaOpen] = useState(false);
  const [taState, setTaState] = useState({ loading: false, data: null, error: null });
  const [taTimeframe, setTaTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [taLive, setTaLive] = useState(false);
  const hasTinkoffToken = !!userProfile?.tinkoffToken;
  const taTimeframeOptions = useMemo(() => availableTimeframes(hasTinkoffToken), [hasTinkoffToken]);
  // Tracks which "forming" setups were on screen after the last poll, so the next poll
  // can tell "confirmed" / "invalidated" apart from "nothing changed" — a detector run
  // in isolation is stateless by design (see patterns.js), so this diffing has to live
  // here, in the one place that actually watches the same ticker over time.
  const formingKeysRef = useRef(new Set());

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

  useEffect(() => {
    if (showJournalModal || showTinkoffModal) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prevOverflow; };
    }
  }, [showJournalModal, showTinkoffModal]);

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

  // Re-evaluates the trader's own strategy checklist whenever the ticker analysis or the
  // plan numbers change — plan conditions (R:R, risk %) come from the Calculator's own
  // form, market conditions from the fetched candles. Neither half computes anything new
  // here; this just feeds both into the same evaluator used everywhere else.
  // Умное направление
  const activeDirection = (() => {
    const sl = parseFloat(form.stopLoss);
    const entry = parseFloat(form.entryPrice);
    if (sl && entry) return sl < entry ? 'long' : 'short';
    return forcedDir;
  })();

  const strategyResult = useMemo(() => {
    if (!userProfile?.strategy?.conditions?.length) return null;
    if (!taState.data) return null;
    return evaluateStrategy(userProfile.strategy, {
      indicators: taState.data.indicators,
      patterns: taState.data.patterns,
      marketContext: taState.data.marketContext,
      // The trader's planned entry (limit price) and direction — price-relative
      // conditions judge the plan, not the current quote, and direction-bound
      // conditions skip the opposite side. See evaluateStrategy.
      direction: activeDirection,
      plan: {
        rr: displayResult?.rr ?? null,
        riskPercent: parseFloat(form.riskPercent) || null,
        marginUsagePercent: displayResult?.marginUsagePercent ?? null,
        entryPrice: parseFloat(form.entryPrice) || null,
      },
    });
  }, [userProfile?.strategy, taState.data, displayResult, form.riskPercent, form.entryPrice, activeDirection]);

  const rrColor = !displayResult ? '' : displayResult.rr >= 2 ? 'var(--green)' : displayResult.rr >= 1 ? 'var(--gold)' : 'var(--red)';

  // Which ticker the current form numbers (SL/TP, contract specs) belong to — reloading
  // the SAME ticker to refresh its price must not wipe the trader's stop/take, but
  // loading a DIFFERENT one must (stale SL from the previous instrument is a footgun,
  // real user report).
  const loadedTickerRef = useRef(null);

  const loadInstrument = useCallback(async () => {
    if (!form.ticker) { toast.error('Введите тикер'); return; }
    const ticker = form.ticker.toUpperCase();
    const isNewTicker = loadedTickerRef.current && loadedTickerRef.current !== ticker;

    setLoadingPrice(true);
    try {
      if (priceSource === 'moex') {
        // MOEX — цена, имя/экспирация контракта, а для фьючерсов ещё и ГО/шаг цены/лот
        // с бесплатного ISS API (если контракт сейчас торгуется — иначе вручную).
        const price = await getMoexPrice(ticker, instrumentType);
        if (!price) { toast.error('Инструмент не найден на MOEX'); return; }
        fetchMoexSecurityInfo(ticker).then((info) => { if (info) setInstrumentInfo(info); });
        if (orderType === 'market') set('entryPrice', String(price));
        if (isNewTicker) setForm(f => ({ ...f, stopLoss: '', takeProfit: '' }));
        if (instrumentType === 'future') {
          const card = await fetchActiveFutureCard(ticker);
          if (card) {
            const fmtNum = (n) => n ? String(n).replace(',', '.') : '';
            setForm(f => ({
              ...f,
              lot: String(card.lot || 1),
              minStep: fmtNum(card.minPriceIncrement) || '1',
              minStepAmount: fmtNum(card.minPriceIncrementAmount) || '',
              initialMargin: fmtNum(card.initialMargin) || '',
            }));
            toast.success(`${ticker}: ${price} ₽, ГО и шаг цены подтянуты с MOEX (задержка 15 мин)`);
          } else {
            toast.success(`${ticker}: ${price} ₽ (MOEX, задержка 15 мин). ГО/шаг цены не найдены — введите вручную`);
          }
        } else {
          toast.success(`${ticker}: ${price} ₽ (MOEX, задержка 15 мин)`);
        }
        loadedTickerRef.current = ticker;
      } else {
        // Тинькофф
        if (!tapi) { toast.error('Введите API-токен в настройках'); return; }
        const raw = instrumentType === 'stock'
          ? await tapi.getShareByTicker(ticker)
          : await tapi.getFutureByTicker(ticker);
        if (!raw) { toast.error(`Инструмент ${ticker} не найден`); return; }
        const info = instrumentType === 'stock' ? parseShareInfo(raw) : parseFutureInfo(raw);
        setInstrumentInfo(info);
        const price = await tapi.getLastPrice(info.figi);
        const fmtNum = (n) => n ? String(n).replace(',', '.') : '';
        setForm(f => ({
          ...f,
          entryPrice: (orderType === 'market' && price) ? String(price) : f.entryPrice,
          stopLoss: isNewTicker ? '' : f.stopLoss,
          takeProfit: isNewTicker ? '' : f.takeProfit,
          lot: String(info.lot || 1),
          minStep: fmtNum(info.minPriceIncrement) || '1',
          minStepAmount: fmtNum(info.minPriceIncrementAmount) || '',
          initialMargin: fmtNum(info.initialMargin) || '',
        }));
        if (price) toast.success(`${info.ticker}: ${price} ₽`);
        loadedTickerRef.current = ticker;
      }
    } catch (e) {
      toast.error('Ошибка: ' + e.message);
    } finally {
      setLoadingPrice(false);
    }
  }, [tapi, form.ticker, instrumentType, priceSource, orderType]);

  // Switching the order type to "по рынку" implies "I want the market's price now" —
  // before this, the stale limit price silently stayed in the field until the trader
  // re-clicked «Загрузить» (real user report).
  const prevOrderTypeRef = useRef(orderType);
  useEffect(() => {
    const prev = prevOrderTypeRef.current;
    prevOrderTypeRef.current = orderType;
    if (prev === orderType || orderType !== 'market') return;
    if (!loadedTickerRef.current || loadedTickerRef.current !== (form.ticker || '').toUpperCase()) return;
    (async () => {
      try {
        if (priceSource === 'moex') {
          const price = await getMoexPrice(loadedTickerRef.current, instrumentType);
          if (price) set('entryPrice', String(price));
        } else if (tapi && instrumentInfo?.figi) {
          const price = await tapi.getLastPrice(instrumentInfo.figi);
          if (price) set('entryPrice', String(price));
        }
      } catch { /* цену обновим при следующем «Загрузить» */ }
    })();
  }, [orderType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stale analysis for a different ticker (or timeframe) would be misleading — clear it
  // as soon as the trader edits the ticker field or switches timeframe, so they never
  // see SBER's daily figures while looking at GAZP on M15. Closing the panel too (not
  // just wiping its data) matters: leaving `taOpen` true with `taState.data` null used
  // to render an empty card with nothing in it — a blank patch of screen the trader
  // couldn't explain (real user report).
  useEffect(() => {
    setTaState({ loading: false, data: null, error: null });
    setTaLive(false);
    setTaOpen(false);
    formingKeysRef.current = new Set();
  }, [form.ticker, instrumentType, taTimeframe]);

  // Scrolls the analysis panel into view the moment it opens — before this, clicking
  // «Технический анализ» with the panel below the fold gave no visible feedback at all,
  // so a trader who couldn't see it assumed the click did nothing (real user report).
  const taPanelRef = useRef(null);
  useEffect(() => {
    if (taOpen) taPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [taOpen]);

  // If the trader loses their token, or a timeframe becomes unavailable for some other
  // reason, don't leave the selector pointed at a now-invalid choice.
  useEffect(() => {
    if (!taTimeframeOptions.some((tf) => tf.key === taTimeframe)) setTaTimeframe(DEFAULT_TIMEFRAME);
  }, [taTimeframeOptions, taTimeframe]);

  // `silent` is true for background live-polling ticks — those shouldn't flash the
  // loading spinner or steal focus by (re)opening the panel; only the first, manual
  // click does that. On-demand by default (no polling) still applies: this function
  // itself never schedules its own next call, the "🔴 Live" effect below does that.
  const loadAnalysis = async (silent = false) => {
    if (!form.ticker) { if (!silent) toast.error('Введите тикер'); return; }
    if (!silent) { setTaOpen(true); setTaState({ loading: true, data: null, error: null }); }
    try {
      const now = new Date();
      const candles = await fetchDailyCandles({
        ticker: form.ticker.toUpperCase(),
        instrumentType,
        toDate: now,
        tinkoffToken: userProfile?.tinkoffToken,
        timeframe: taTimeframe,
      });
      const indicators = computeIndicatorsAtEntry(candles, now);
      const patterns = computePatternsAtEntry(candles, now, { timeframeMinutes: TIMEFRAMES[taTimeframe]?.minutes });
      const marketContext = computeMarketContextAtEntry(candles, now);
      if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
      setTaState({ loading: false, data: { indicators, patterns, marketContext }, error: null });
      diffFormingStatuses(patterns);
    } catch (e) {
      if (!silent) setTaState({ loading: false, data: null, error: e.message || 'Не удалось загрузить данные' });
    }
  };

  // Compares this poll's forming candidates against the last poll's (by `levelPrice`,
  // since a pattern's own price is the only stable identity across time) and toasts on
  // the two transitions a trader actually cares about: a forming setup just confirmed,
  // or it just fell apart. "Still forming, nothing new" produces no notification — that
  // would be noise on every single poll.
  const diffFormingStatuses = (patterns) => {
    const candidates = patterns?.candidates || [];
    const nowForming = new Set(candidates.filter((c) => c.status === 'forming' && c.levelPrice != null)
      .map((c) => `${c.pattern}-${c.levelPrice.toFixed(2)}`));
    const nowConfirmedKeys = new Set(candidates.filter((c) => c.status === 'confirmed' && c.levelPrice != null)
      .map((c) => `${c.pattern}-${c.levelPrice.toFixed(2)}`));

    for (const prevKey of formingKeysRef.current) {
      if (nowForming.has(prevKey)) continue; // still forming, nothing to report
      const [pattern] = prevKey.split('-');
      const label = PATTERN_LABELS[pattern] || pattern;
      if ([...nowConfirmedKeys].some((k) => k.startsWith(pattern))) {
        toast.success(`✅ Сетап «${label}» подтвердился`);
      } else {
        toast(`❌ Сетап «${label}» отменился — цена ушла дальше`, { icon: '⚠️' });
      }
    }
    formingKeysRef.current = nowForming;
  };

  // Live polling for the technical-analysis panel — separate from the price
  // autorefresh below (that one's about the trade price, this one's about pattern
  // status). Poll interval scales with the chosen timeframe: no point re-checking
  // daily candles every 30 seconds, and M5 needs to be checked far more often than D1
  // for "forming" status to mean anything. Only runs while this tab is open — a known,
  // already-discussed limitation (real push notifications need a server, later).
  useEffect(() => {
    if (!taLive || !form.ticker) return;
    const minutes = TIMEFRAMES[taTimeframe]?.minutes || 1440;
    const intervalMs = Math.max(30000, Math.min(600000, minutes * 10000));
    const interval = setInterval(() => loadAnalysis(true), intervalMs);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taLive, form.ticker, instrumentType, taTimeframe]);

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
      const openedAtDate = new Date(openedAt);
      await addTrade(user.uid, {
        ticker: form.ticker || instrumentInfo?.ticker || '',
        date: openedAtDate.toISOString().split('T')[0],
        openedAt: openedAtDate.toISOString(),
        status: 'open',
        direction: activeDirection || displayResult.direction,
        entryPrice: parseFloat(form.entryPrice),
        intendedEntryPrice: parseFloat(form.entryPrice) || null,
        exitPrice: null,
        stopLoss: parseFloat(form.stopLoss) || null,
        takeProfit: parseFloat(form.takeProfit) || null,
        volume: effectiveContracts,
        lot: parseFloat(form.lot) || 1,
        // Without instrumentType/isFuture the Journal treats every Calculator trade as a
        // stock — futures then look up candles on the shares board and show "нет
        // исторических свечей" (real user report). Contract specs ride along so closing
        // the trade later can convert points to rubles without re-fetching them.
        instrumentType,
        isFuture: instrumentType === 'future',
        minStep: parseFloat(form.minStep) || null,
        minStepAmount: parseFloat(form.minStepAmount) || null,
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
        // The timeframe the trader was actually analysing on when they opened the trade —
        // the Journal's auto-timeframe uses this over its duration-based guess.
        entryTimeframe: taTimeframe || null,
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
        .calc-modal-overlay {
          position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);
          -webkit-backdrop-filter:blur(8px);
          z-index:1000;display:flex;align-items:center;justify-content:center;
          padding:20px; overflow-y:auto;
        }
        .calc-modal {
          background:var(--bg-surface);border:1px solid var(--border-medium);
          border-radius:24px;padding:28px;width:100%;max-width:520px;
          max-height:calc(100vh - 40px); overflow-y:auto;
          animation:modalPop 0.25s cubic-bezier(0.16,1,0.3,1);
          margin:auto;
        }
        @keyframes modalPop { from{transform:scale(0.95);opacity:0} to{transform:scale(1);opacity:1} }
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
            // Switching source used to wipe the entry price and force a limit order —
            // meant to avoid a stale Tinkoff quote bleeding into a MOEX calc, but it
            // broke the whole plan the trader had just built (real user report: "расчёт
            // слетает"). Just switch the source; «Загрузить» already refreshes the price
            // from wherever's now selected, same as changing the ticker does.
            onClick={() => setPriceSource(val)}
          >{label}</button>
        ))}
      </div>

      {priceSource === 'moex' && (
        <div style={{background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.3)',borderRadius:10,padding:'8px 14px',marginBottom:16,fontSize:12,color:'var(--gold)'}}>
          ⚠️ MOEX: данные с задержкой ~15 минут. Работает без токена Тинькофф. Для фьючерсов ГО и шаг цены подтягиваются автоматически (если контракт сейчас торгуется), иначе — вводятся вручную.
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
            {/* Отдельная, менее нагруженная кнопка — технический анализ не относится
                к загрузке цены, поэтому не толпится рядом с ней */}
            <div style={{display:'flex', gap:6, marginTop:10, flexWrap:'wrap'}}>
              {taTimeframeOptions.map((tf) => (
                <button key={tf.key}
                  onClick={() => setTaTimeframe(tf.key)}
                  style={{
                    padding:'4px 10px', borderRadius:8, fontSize:11, fontFamily:'inherit', cursor:'pointer',
                    border: `1px solid ${taTimeframe === tf.key ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                    background: taTimeframe === tf.key ? 'rgba(79,70,229,0.12)' : 'transparent',
                    color: taTimeframe === tf.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                  }}
                >{tf.label}</button>
              ))}
              {!hasTinkoffToken && (
                <span className="text-xs text-muted" style={{alignSelf:'center'}} title="М5 и М15 доступны только с токеном Т-Инвестиций (Настройки)">
                  М5/М15 — нужен токен
                </span>
              )}
            </div>
            <div style={{display:'flex', gap:6, marginTop:6}}>
              <button
                onClick={() => loadAnalysis()}
                disabled={taState.loading}
                style={{
                  flex:1, padding:'9px 14px',
                  background:'transparent', border:'1px dashed var(--border-medium)',
                  borderRadius:10, color:'var(--text-secondary)',
                  fontFamily:'inherit', fontSize:13, cursor:'pointer',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:6,
                  transition:'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; e.currentTarget.style.color = 'var(--accent-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-medium)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
              >
                {taState.loading ? <div className="spinner" style={{width:13,height:13}}/> : '📊'} Технический анализ по тикеру
              </button>
              <button
                onClick={() => setTaLive((v) => !v)}
                disabled={!form.ticker}
                title={taLive ? 'Остановить автообновление' : 'Включить автообновление панели (пока открыта эта вкладка браузера)'}
                style={{
                  padding:'9px 12px', borderRadius:10, cursor: form.ticker ? 'pointer' : 'not-allowed',
                  border: `1px solid ${taLive ? 'var(--red)' : 'var(--border-medium)'}`,
                  background: taLive ? 'rgba(239,68,68,0.12)' : 'transparent',
                  color: taLive ? 'var(--red)' : 'var(--text-secondary)',
                  fontFamily:'inherit', fontSize:13, fontWeight:600, whiteSpace:'nowrap',
                }}
              >
                {taLive ? '🔴 Live' : '⚪ Live'}
              </button>
            </div>
            {taLive && (
              <div className="text-xs text-muted" style={{marginTop:6}}>
                Автообновление включено — работает, пока эта вкладка браузера открыта.
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
                <label className="input-label">Тейк-профит</label>
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
                <button
                  className="btn"
                  style={{flex:1,background:'linear-gradient(135deg,#ffdd2d,#f5a623)',color:'#1a1a1a',border:'none',borderRadius:12,fontWeight:700,fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}
                  onClick={() => setShowTinkoffModal(true)}
                >
                  <span style={{
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                    width:18, height:18, borderRadius:5,
                    background:'#1a1a1a', color:'#ffdd2d',
                    fontWeight:800, fontSize:11, fontFamily:"'Syne',sans-serif", flexShrink:0,
                  }}>T</span>
                  В Т-Банк
                </button>
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

      {/* Живая панель технического анализа — module 4, "живая панель" из архитектуры */}
      {taOpen && (
        <div ref={taPanelRef} className="card" style={{marginTop:16}}>
          <div className="section-title">
            <div className="section-title-icon">📊</div>
            Технический анализ {form.ticker ? `— ${form.ticker.toUpperCase()}` : ''}
          </div>
          <TechnicalAnalysisBlock
            state={taState}
            onRefresh={() => loadAnalysis()}
            title={`На данный момент (${TIMEFRAMES[taTimeframe]?.label || taTimeframe})`}
          />
        </div>
      )}

      {taOpen && strategyResult && (
        <StrategyChecklist strategyName={userProfile?.strategy?.name} result={strategyResult} />
      )}
      {taOpen && taState.data && !userProfile?.strategy?.conditions?.length && (
        <div className="card" style={{marginTop:16, textAlign:'center', padding:'20px'}}>
          <div className="text-sm text-secondary">
            Стратегия ещё не настроена — соберите чек-лист условий во вкладке{' '}
            <a href="/capital" style={{color:'var(--accent-primary)'}}>Капитал → Моя стратегия</a>,
            и здесь появится счётчик «N из M».
          </div>
        </div>
      )}

      {/* Модалка Т-Банк */}
      {showTinkoffModal && displayResult && (
        <div className="calc-modal-overlay" onClick={() => setShowTinkoffModal(false)}>
          <div className="calc-modal" onClick={e => e.stopPropagation()}>
            {/* Заголовок */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
              <div>
                <div style={{fontSize:18,fontWeight:700,color:'var(--text-primary)',display:'flex',alignItems:'center',gap:8}}>
                  <span style={{
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                    width:24, height:24, borderRadius:7,
                    background:'linear-gradient(135deg,#ffdd2d,#f5a623)', color:'#1a1a1a',
                    fontWeight:800, fontSize:13, fontFamily:"'Syne',sans-serif", flexShrink:0,
                  }}>T</span>
                  Открыть в Т-Банке
                </div>
                <div style={{fontSize:12,color:'var(--text-muted)',marginTop:2}}>Скопируй параметры и введи в приложении</div>
              </div>
              <button onClick={() => setShowTinkoffModal(false)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',fontSize:20}}>✕</button>
            </div>

            {/* Параметры */}
            <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:20}}>
              {[
                ['Тикер', form.ticker || '—'],
                ['Направление', activeDirection === 'long' ? '↑ Лонг' : '↓ Шорт'],
                ['Тип заявки', orderType === 'market' ? '⚡ По рынку' : '🎯 Лимитная'],
                ...(orderType === 'limit' ? [['Цена заявки', form.entryPrice || '—']] : []),
                ['Контрактов', String(effectiveContracts)],
                ['Стоп-лосс', form.stopLoss || '—'],
                ...(form.takeProfit ? [['Тейк-профит', form.takeProfit]] : []),
              ].map(([label, value]) => (
                <div key={label} style={{
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  background:'var(--bg-surface-2)',
                  border:'1px solid var(--border-subtle)',
                  borderRadius:12, padding:'10px 14px',
                }}>
                  <span style={{fontSize:13,color:'var(--text-muted)'}}>{label}</span>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>{value}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(value).catch(()=>{});
                        setTinkoffCopied(label);
                        setTimeout(() => setTinkoffCopied(''), 1500);
                      }}
                      style={{
                        background: tinkoffCopied === label ? 'rgba(16,185,129,0.15)' : 'var(--bg-surface-3)',
                        border: `1px solid ${tinkoffCopied === label ? 'rgba(16,185,129,0.4)' : 'var(--border-subtle)'}`,
                        borderRadius:8, padding:'4px 10px',
                        cursor:'pointer', fontSize:11, fontFamily:'inherit',
                        color: tinkoffCopied === label ? 'var(--green)' : 'var(--text-muted)',
                        transition:'all 0.15s', whiteSpace:'nowrap',
                      }}
                    >
                      {tinkoffCopied === label ? '✓ Скопировано' : '📋 Копировать'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Кнопка открыть */}
            <button
              style={{
                width:'100%', padding:'14px', border:'none', borderRadius:14,
                background:'linear-gradient(135deg,#ffdd2d,#f5a623)',
                color:'#1a1a1a', fontFamily:'inherit', fontSize:15, fontWeight:700,
                cursor:'pointer', boxShadow:'0 4px 16px rgba(245,166,35,0.3)',
                transition:'transform 0.2s',
                display:'flex', alignItems:'center', justifyContent:'center', gap:8,
              }}
              onMouseEnter={e => e.currentTarget.style.transform='translateY(-1px)'}
              onMouseLeave={e => e.currentTarget.style.transform=''}
              onClick={() => {
                const ticker = form.ticker || '';
                const isFuture = instrumentType === 'future';
                const website = isFuture
                  ? `https://www.tbank.ru/invest/futures/${ticker}/`
                  : `https://www.tbank.ru/invest/stocks/${ticker}/`;
                // Прямая навигация даёт iOS/Android шанс перехватить Universal Link
                // и открыть установленное приложение Т-Инвестиций вместо браузера.
                window.location.href = website;
              }}
            >
              <span style={{
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                width:20, height:20, borderRadius:6,
                background:'#1a1a1a', color:'#ffdd2d',
                fontWeight:800, fontSize:12, fontFamily:"'Syne',sans-serif",
                flexShrink:0,
              }}>T</span>
              Открыть {form.ticker || 'инструмент'} в Т-Банке →
            </button>
            <p style={{textAlign:'center',fontSize:11,color:'var(--text-muted)',marginTop:8}}>
              Откроется приложение или сайт Т-Банка
            </p>
            <p style={{textAlign:'center',fontSize:11,color:'var(--text-muted)',marginTop:4}}>
              Если откроется не та страница — тикер «{form.ticker || '—'}» уже скопирован, найдите его поиском
            </p>
          </div>
        </div>
      )}

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
                <label className="input-label">Время открытия</label>
                <input className="input" type="datetime-local" value={openedAt}
                  onChange={e => setOpenedAt(e.target.value)} />
              </div>

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
