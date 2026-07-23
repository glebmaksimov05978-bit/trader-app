// src/components/journal/Journal.js
import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, addTrade, updateTrade, deleteTrade, calcStats, resolveOpenedAt, resolveClosedAt } from '../../services/trades';
import { formatCurrency, formatNumber } from '../../utils/calculator';
import { fetchDailyCandles, availableTimeframes, recommendTimeframe, TIMEFRAMES, DEFAULT_TIMEFRAME } from '../../services/marketData/candles';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { getActiveStrategy } from '../../services/analytics/strategy';
import { isFuturesCode, isCurrencyCode } from '../../services/import/instrumentResolver';
import { addRadarItem, getRadarItems, deleteRadarItem } from '../../services/radar';
import { useRadarLive } from '../../context/RadarLiveContext';
import TechnicalAnalysisBlock from '../shared/TechnicalAnalysisBlock';
import CandleChart from '../shared/CandleChart';
import toast from 'react-hot-toast';
import TradeModal from './TradeModal';
import ImportModal from './ImportModal';
import './Journal.css';

const COLS = ['Тикер', 'Дата', 'Направление', 'Вход', 'Выход', 'Объём', 'P&L', '% депоз.', 'Статус', ''];

export default function Journal() {
  const { user, userProfile } = useAuth();
  const activeStrategy = getActiveStrategy(userProfile);
  const { radarLive, setRadarLive, radarUpdatedAt, radarResults } = useRadarLive();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTrade, setEditTrade] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  // Быстрое закрытие сделки
  const [closeModal, setCloseModal] = useState(null);
  // Кастомный confirm вместо window.confirm
  const [confirmDelete, setConfirmDelete] = useState(null); // trade.id // trade object
  const [closePrice, setClosePrice] = useState('');
  const [closedAt, setClosedAt] = useState('');
  const [closing, setClosing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  // tradeId -> { loading, data, error }
  const [indicatorsState, setIndicatorsState] = useState({});
  // tradeId -> ключ таймфрейма ('M5'|'M10'|...), выбранный вручную для этой сделки —
  // до первого клика на переключателе используется рекомендация по длительности сделки
  const [tfOverride, setTfOverride] = useState({});
  // tradeId -> текст, который трейдер вводит в поле "стоимость шага цены, ₽"
  const [manualStepInput, setManualStepInput] = useState({});
  const [savingManualSpec, setSavingManualSpec] = useState(null); // tradeId в процессе сохранения
  // "Сделки" | "Радар" — watchlist of tickers with a setup forming, kept separate from
  // the trades table because a radar item isn't a position yet.
  const [view, setView] = useState('trades');
  const [radarItems, setRadarItems] = useState([]);
  const [radarLoading, setRadarLoading] = useState(true);
  const [radarState, setRadarState] = useState({}); // itemId -> { loading, data, error }
  const [radarTfOverride, setRadarTfOverride] = useState({});
  const [addRadarOpen, setAddRadarOpen] = useState(false);
  const [radarForm, setRadarForm] = useState({ ticker: '', instrumentType: 'stock', note: '', timeframe: DEFAULT_TIMEFRAME });
  // Once the trader manually picks a type, stop overriding it as they keep typing.
  const [radarTypeTouched, setRadarTypeTouched] = useState(false);

  const guessInstrumentType = (ticker) => {
    if (isCurrencyCode(ticker)) return 'currency';
    if (isFuturesCode(ticker)) return 'future';
    return 'stock';
  };
  const [confirmDeleteRadar, setConfirmDeleteRadar] = useState(null);

  const deposit = userProfile?.depositSize || 100000;

  const load = useCallback(async () => {
    if (!user) return;
    const t = await getUserTrades(user.uid);
    setTrades(t);
    setStats(calcStats(t));
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Manual fallback for futures whose tick value neither Tinkoff nor the free MOEX
  // lookup could resolve (see resolveFuturesPnl/resolveFuturesSpecFromMoex) — asking
  // for "rubles per 1 point" rather than separate tick-size/tick-value fields matches
  // how traders already think about a contract ("сколько я зарабатываю на пункт"),
  // and it's the exact multiplier the stored pnlPoints needs to become rubles.
  const saveManualSpec = useCallback(async (trade) => {
    const raw = manualStepInput[trade.id];
    const rubPerPoint = parseFloat(String(raw).replace(',', '.'));
    if (!rubPerPoint || rubPerPoint <= 0) {
      toast.error('Введите положительное число рублей за пункт');
      return;
    }
    setSavingManualSpec(trade.id);
    try {
      const pnl = Math.round((trade.pnlPoints * rubPerPoint - (trade.commission || 0)) * 100) / 100;
      await updateTrade(trade.id, { pnl, pnlNeedsSpecs: false, manualRubPerPoint: rubPerPoint });
      toast.success('P&L пересчитан');
      await load();
    } catch (e) {
      toast.error('Ошибка сохранения: ' + e.message);
    } finally {
      setSavingManualSpec(null);
    }
  }, [manualStepInput, load]);

  const loadRadar = useCallback(async () => {
    if (!user) return;
    setRadarLoading(true);
    const items = await getRadarItems(user.uid);
    setRadarItems(items);
    setRadarLoading(false);
  }, [user]);

  useEffect(() => { if (view === 'radar') loadRadar(); }, [view, loadRadar]);

  const handleSave = async (data) => {
    try {
      // A prefilled "from radar" trade has no `.id` (it's not an existing document) —
      // that's what tells us to create rather than update, same as a brand-new trade.
      if (editTrade?.id) {
        await updateTrade(editTrade.id, data);
        toast.success('Сделка обновлена');
      } else {
        await addTrade(user.uid, data);
        toast.success('Сделка добавлена');
      }
      setModalOpen(false);
      setEditTrade(null);
      await load();
    } catch (e) {
      toast.error('Ошибка сохранения');
    }
  };

  const handleDelete = async (id) => {
    setConfirmDelete(id);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    await deleteTrade(confirmDelete);
    toast.success('Сделка удалена');
    setConfirmDelete(null);
    await load();
  };

  const openEdit = (trade) => {
    setEditTrade(trade);
    setModalOpen(true);
  };

  // Быстрое закрытие: открыть мини-модал
  const openClose = (trade) => {
    setCloseModal(trade);
    setClosePrice('');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    setClosedAt(`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
  };

  // Автоматический расчёт P&L при закрытии
  const calcQuickPnl = () => {
    const exit = parseFloat(closePrice);
    const entry = parseFloat(closeModal?.entryPrice);
    const vol = parseFloat(closeModal?.remainingVolume ?? closeModal?.volume) || 1;
    const lot = parseFloat(closeModal?.lot) || 1;
    const step = parseFloat(closeModal?.minStep) || 1;
    const stepAmt = parseFloat(closeModal?.minStepAmount) || 0;
    const commRate = parseFloat(closeModal?.commissionRate) || 0.0006;
    const dir = closeModal?.direction;

    if (!exit || !entry) return null;

    let pnl;
    if (step && stepAmt) {
      const ticks = (exit - entry) / step;
      pnl = (dir === 'long' ? ticks : -ticks) * stepAmt * vol * lot;
    } else {
      pnl = (dir === 'long' ? (exit - entry) : (entry - exit)) * vol * lot;
    }

    const commission = entry * vol * lot * commRate * 2;
    const net = pnl - commission;
    return { pnl: Math.round(net * 100) / 100, commission: Math.round(commission * 100) / 100 };
  };

  const handleQuickClose = async () => {
    if (!closePrice || !closeModal) return;
    setClosing(true);
    try {
      const result = calcQuickPnl();
      const closedAtDate = closedAt ? new Date(closedAt) : new Date();
      const remaining = closeModal.remainingVolume ?? closeModal.volume;
      const patch = {
        ...closeModal,
        exitPrice: parseFloat(closePrice),
        status: 'closed',
        remainingVolume: 0,
        // Add to whatever P&L/commission the position already accumulated from
        // earlier partial closes, rather than overwriting it.
        pnl: (closeModal.pnl ?? 0) + (result?.pnl ?? 0),
        commission: (closeModal.commission ?? 0) + (result?.commission ?? 0),
        closeDate: closedAtDate.toISOString(),
        closedAt: closedAtDate.toISOString(),
      };
      // Manually closing an imported position that still has a step-by-step history
      // appends one more "close" leg instead of silently disappearing from it.
      if (Array.isArray(closeModal.legs)) {
        patch.legs = [...closeModal.legs, {
          type: 'close',
          side: closeModal.direction === 'long' ? 'sell' : 'buy',
          price: parseFloat(closePrice),
          quantity: remaining,
          commission: result?.commission ?? 0,
          timestampUtc: closedAtDate.toISOString(),
          dealNumber: null,
        }];
      }
      await updateTrade(closeModal.id, patch);
      toast.success(`Сделка закрыта. P&L: ${patch.pnl >= 0 ? '+' : ''}${formatCurrency(patch.pnl)}`);
      setCloseModal(null);
      setClosePrice('');
      await load();
    } catch (e) {
      toast.error('Ошибка закрытия сделки');
    } finally {
      setClosing(false);
    }
  };

  const quickResult = closeModal && closePrice ? calcQuickPnl() : null;

  // Auto-picks a timeframe for the analysis panel. Priority: the timeframe the trader
  // actually analysed on when opening the trade (saved by the Calculator) → the user's
  // preferred timeframe from Settings → a guess from how long the trade was held. For
  // still-open trades the "held" duration is time since open — before this fix they had
  // no close date, got null duration and always landed on Д1, ignoring the trader's own
  // choice at entry (real user report). The switcher still overrides everything.
  const defaultTimeframeFor = (trade) => {
    if (trade.entryTimeframe) return trade.entryTimeframe;
    if (userProfile?.preferredTimeframe) return userProfile.preferredTimeframe;
    const opened = resolveOpenedAt(trade);
    const closed = resolveClosedAt(trade) || new Date();
    const durationMinutes = opened ? (closed.getTime() - opened.getTime()) / 60000 : null;
    return recommendTimeframe(durationMinutes, !!userProfile?.tinkoffToken);
  };

  const timeframeFor = (trade) => tfOverride[trade.id] || defaultTimeframeFor(trade);

  // Fetches candles once per trade+timeframe, derives both indicators and pattern
  // candidates from the same series, and persists them to technicalAnalysis so
  // re-opening the row later doesn't re-hit the market data API. `force` bypasses the
  // Firestore cache — used by the "Обновить" button and by switching timeframe (a
  // cached snapshot on a different timeframe is stale for the newly selected one).
  // `timeframeArg` lets a just-changed timeframe take effect immediately instead of
  // waiting on the tfOverride state update to land (setState is async/batched).
  const loadIndicators = async (trade, force = false, timeframeArg = null) => {
    const timeframe = timeframeArg || timeframeFor(trade);
    const cached = trade.technicalAnalysis;
    if (!force && cached?.indicators && cached?.patterns && cached?.timeframe === timeframe) {
      setIndicatorsState((s) => ({ ...s, [trade.id]: { loading: false, data: cached, error: null } }));
      // The Firestore cache never stored candles (would bloat every trade doc for no
      // benefit — see the comment below where they're added to state). Fetch just the
      // candle series in the background so the chart still has something to draw,
      // without redoing the indicator/pattern math or re-writing Firestore.
      (async () => {
        try {
          const openedAt = resolveOpenedAt(trade);
          if (!openedAt) return;
          // Candles extend through the EXIT (or "now" for still-open trades), not just
          // entry — the chart needs to draw every leg and the exit marker, which happen
          // after entry. The indicators/patterns text panel below still anchors strictly
          // to `openedAt` (indexAtOrBefore), so this doesn't leak hindsight into "on
          // entry" numbers — it only gives the chart more bars to place markers on.
          const candles = await fetchDailyCandles({
            ticker: trade.ticker,
            instrumentType: trade.instrumentType || guessInstrumentType(trade.ticker),
            toDate: resolveClosedAt(trade) || new Date(),
            tinkoffToken: userProfile?.tinkoffToken,
            timeframe,
          });
          setIndicatorsState((s) => (s[trade.id]?.data === cached
            ? { ...s, [trade.id]: { loading: false, data: { ...cached, candles }, error: null } }
            : s));
        } catch { /* chart just stays hidden if this fails — indicators already shown */ }
      })();
      return;
    }
    setIndicatorsState((s) => ({ ...s, [trade.id]: { loading: true, data: null, error: null } }));
    try {
      const openedAt = resolveOpenedAt(trade);
      if (!openedAt) throw new Error('Нет даты открытия сделки');
      // Older Calculator trades were saved without instrumentType — guessing from the
      // ticker code (same resolver the import uses) beats defaulting them all to
      // 'stock', which made futures look up candles on the shares board and fail.
      const candles = await fetchDailyCandles({
        ticker: trade.ticker,
        instrumentType: trade.instrumentType || guessInstrumentType(trade.ticker),
        toDate: resolveClosedAt(trade) || new Date(),
        tinkoffToken: userProfile?.tinkoffToken,
        timeframe,
      });
      const indicators = computeIndicatorsAtEntry(candles, openedAt);
      const patterns = computePatternsAtEntry(candles, openedAt);
      const marketContext = computeMarketContextAtEntry(candles, openedAt);
      if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
      const result = { indicators, patterns, marketContext, timeframe };
      // `candles` stays local-state-only (not spread into `result`) — it's only needed
      // to draw the chart in this session, and saving a whole candle history into every
      // trade document would bloat Firestore for no benefit (the chart just refetches).
      setIndicatorsState((s) => ({ ...s, [trade.id]: { loading: false, data: { ...result, candles }, error: null } }));
      await updateTrade(trade.id, { technicalAnalysis: { ...(trade.technicalAnalysis || {}), ...result } });
    } catch (e) {
      setIndicatorsState((s) => ({ ...s, [trade.id]: { loading: false, data: null, error: e.message || 'Не удалось загрузить данные' } }));
    }
  };

  const changeTimeframe = (trade, tf) => {
    setTfOverride((s) => ({ ...s, [trade.id]: tf }));
    loadIndicators(trade, true, tf);
  };

  const changeRadarTimeframe = (item, tf) => {
    setRadarTfOverride((s) => ({ ...s, [item.id]: tf }));
    loadRadarAnalysis(item, true, tf);
  };

  // Same computation as loadIndicators, but anchored to "now" instead of a trade's
  // entry date, and deliberately not cached in Firestore — a radar item's whole point
  // is to reflect the current moment, so a stale cache would defeat it. Refetches every
  // time the row is opened or "Обновить" is pressed.
  const radarTimeframeFor = (item) => radarTfOverride[item.id] || item.timeframe || DEFAULT_TIMEFRAME;

  const loadRadarAnalysis = async (item, force = false, timeframeArg = null) => {
    if (!force && radarState[item.id]?.data) return;
    const timeframe = timeframeArg || radarTimeframeFor(item);
    setRadarState((s) => ({ ...s, [item.id]: { loading: true, data: null, error: null } }));
    try {
      const now = new Date();
      const candles = await fetchDailyCandles({
        ticker: item.ticker,
        instrumentType: item.instrumentType || 'stock',
        toDate: now,
        tinkoffToken: userProfile?.tinkoffToken,
        timeframe,
      });
      const indicators = computeIndicatorsAtEntry(candles, now);
      const patterns = computePatternsAtEntry(candles, now, { timeframeMinutes: TIMEFRAMES[timeframe]?.minutes });
      const marketContext = computeMarketContextAtEntry(candles, now);
      if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
      setRadarState((s) => ({ ...s, [item.id]: { loading: false, data: { indicators, patterns, marketContext, candles }, error: null } }));
    } catch (e) {
      setRadarState((s) => ({ ...s, [item.id]: { loading: false, data: null, error: e.message || 'Не удалось загрузить данные' } }));
    }
  };

  const handleAddRadar = async () => {
    if (!radarForm.ticker.trim()) return;
    try {
      await addRadarItem(user.uid, radarForm);
      toast.success('Добавлено в радар');
      setAddRadarOpen(false);
      setRadarForm({ ticker: '', instrumentType: 'stock', note: '', timeframe: DEFAULT_TIMEFRAME });
      setRadarTypeTouched(false);
      await loadRadar();
    } catch (e) {
      toast.error('Ошибка сохранения');
    }
  };

  const handleDeleteRadar = async () => {
    if (!confirmDeleteRadar) return;
    await deleteRadarItem(confirmDeleteRadar);
    toast.success('Удалено из радара');
    setConfirmDeleteRadar(null);
    await loadRadar();
  };

  // Radar items stay in the list after this — the trader may want to fill in another
  // trade from the same setup later, or keep watching it. Deleting is a separate,
  // explicit action.
  const openFromRadar = (item) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    setEditTrade({
      ticker: item.ticker,
      instrumentType: item.instrumentType || 'stock',
      direction: 'long',
      status: 'open',
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    });
    setModalOpen(true);
  };

  const filtered = trades
    .filter(t => {
      if (filter === 'long') return t.direction === 'long';
      if (filter === 'short') return t.direction === 'short';
      if (filter === 'currency') return t.instrumentType === 'currency';
      // A partially closed position still has volume open — group it with "Открытые".
      if (filter === 'open') return t.status === 'open' || t.status === 'partial';
      if (filter === 'closed') return t.status === 'closed';
      return true;
    })
    .filter(t => !search || t.ticker?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      // Открытые и частично закрытые всегда сверху
      const aOpen = a.status === 'open' || a.status === 'partial';
      const bOpen = b.status === 'open' || b.status === 'partial';
      if (aOpen && !bOpen) return -1;
      if (bOpen && !aOpen) return 1;

      const getTs = (t) => {
        // Для открытых — по createdAt (время создания), новые сверху
        if (t.status === 'open' || t.status === 'partial') {
          if (t.createdAt?.seconds) return t.createdAt.seconds * 1000;
          if (t.createdAt) return new Date(t.createdAt).getTime();
        }
        // Для закрытых — по дате закрытия
        if (t.closeDate) return new Date(t.closeDate).getTime();
        if (t.date?.seconds) return t.date.seconds * 1000;
        if (t.date) return new Date(t.date).getTime();
        return 0;
      };
      return getTs(b) - getTs(a);
    });

  const fmtDateTime = (d) => {
    if (!d) return '—';
    const date = d instanceof Date ? d : (d.seconds ? new Date(d.seconds * 1000) : new Date(d));
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit' }) +
      ', ' + date.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
  };

  return (
    <div className="page">
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">📓 Журнал сделок</h1>
          <p className="page-subtitle">
            {view === 'trades' ? 'История всех ваших позиций' : 'Тикеры, за которыми вы следите, пока сетап не подтвердился'}
            {view === 'radar' && radarLive && radarUpdatedAt && (
              <span style={{color:'var(--green)', marginLeft:8}}>
                · обновлено в {radarUpdatedAt.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 page-header-actions">
          {view === 'trades' ? (
            <>
              <button className="btn btn-primary" onClick={() => { setEditTrade(null); setModalOpen(true); }}>
                + Добавить сделку
              </button>
              <button className="btn btn-secondary" onClick={() => setImportOpen(true)}>
                📥 Импортировать отчёт
              </button>
            </>
          ) : (
            <>
              {/* Same shared Live toggle as the Dashboard widget — real user request:
                  it only existed there, not here where the trader spends more time
                  managing the actual watchlist. */}
              {activeStrategy?.conditions?.length > 0 && (
                <button
                  onClick={() => setRadarLive((v) => !v)}
                  title={radarLive ? 'Остановить автопроверку' : 'Проверять все тикеры каждые 5 минут и уведомлять, когда условия стратегии сойдутся (пока открыта вкладка)'}
                  style={{
                    padding:'8px 14px', borderRadius:10, cursor:'pointer',
                    border:`1px solid ${radarLive ? 'var(--red)' : 'var(--border-medium)'}`,
                    background: radarLive ? 'rgba(239,68,68,0.12)' : 'transparent',
                    color: radarLive ? 'var(--red)' : 'var(--text-secondary)',
                    fontFamily:'inherit', fontSize:13, fontWeight:600,
                  }}
                >
                  {radarLive ? '🔴 Live' : '⚪ Live'}
                </button>
              )}
              <button className="btn btn-primary" onClick={() => { setRadarTypeTouched(false); setAddRadarOpen(true); }}>
                + Добавить в радар
              </button>
            </>
          )}
        </div>
      </div>

      <div className="tabs" style={{maxWidth:300, marginBottom:20}}>
        <button className={`tab ${view==='trades'?'active':''}`} onClick={() => setView('trades')}>📓 Сделки</button>
        <button className={`tab ${view==='radar'?'active':''}`} onClick={() => setView('radar')}>📡 Радар</button>
      </div>

      {/* Stats strip */}
      {view === 'trades' && stats && (
        <div className="grid-4" style={{marginBottom:24}}>
          <div className="kpi-card green">
            <div className="kpi-label">Всего сделок</div>
            <div className="kpi-value" style={{color:'var(--green)'}}>{stats.total}</div>
            <div className="kpi-sub">Открытых: {trades.filter(t=>t.status==='open').length}</div>
          </div>
          <div className="kpi-card blue">
            <div className="kpi-label">Винрейт</div>
            <div className="kpi-value" style={{color:'var(--blue)'}}>{stats.winrate.toFixed(1)}%</div>
            <div className="kpi-sub">{stats.wins} прибыльных / {stats.losses} убыточных</div>
          </div>
          <div className={`kpi-card ${stats.totalPnl >= 0 ? 'green' : 'red'}`}>
            <div className="kpi-label">Итого P&L</div>
            <div className="kpi-value" style={{color: stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}}>
              {stats.totalPnl >= 0 ? '+' : ''}{formatCurrency(Math.round(stats.totalPnl))}
            </div>
            <div className="kpi-sub">Матожидание: {formatCurrency(Math.round(stats.expectancy))}</div>
          </div>
          <div className="kpi-card gold">
            <div className="kpi-label">Профит-фактор</div>
            <div className="kpi-value" style={{color:'var(--gold)'}}>{formatNumber(stats.profitFactor, 2)}</div>
            <div className="kpi-sub">Макс. серия побед: {stats.maxWinStreak}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      {view === 'trades' && (
      <div className="journal-toolbar" style={{marginBottom:16}}>
        <div className="tabs" style={{maxWidth:400}}>
          {[['all','Все'],['open','Открытые'],['closed','Закрытые'],['long','Лонг'],['short','Шорт'],['currency','Валюта']].map(([v,l]) => (
            <button key={v} className={`tab ${filter===v?'active':''}`} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>
        <input
          className="input"
          style={{maxWidth:200}}
          placeholder="🔍 Поиск по тикеру"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      )}

      {/* Table */}
      {view === 'trades' && (
      <div className="card" style={{padding:0}}>
        {loading ? (
          <div className="empty-state"><div className="spinner" style={{width:28,height:28}}/></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📓</div>
            <div className="empty-state-title">Нет сделок</div>
            <div className="empty-state-text">Нажмите «Добавить сделку», чтобы начать вести журнал</div>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>{COLS.map(c => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {filtered.map(trade => {
                  const hasHistory = Array.isArray(trade.legs) && trade.legs.length > 1;
                  const isExpanded = expandedId === trade.id;
                  const isPartial = trade.status === 'partial';
                  const statusLabel = trade.status === 'partial' ? 'Частично закрыта'
                    : trade.status === 'closed' ? 'Закрыта' : 'Открыта';
                  const statusCls = trade.status === 'partial' ? 'badge-blue'
                    : trade.status === 'open' ? 'badge-blue'
                    : trade.pnl >= 0 ? 'badge-green' : 'badge-red';
                  return (
                  <React.Fragment key={trade.id}>
                  <tr>
                    <td>
                      <div className="flex gap-2" style={{alignItems:'center'}}>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{padding:'2px 6px'}}
                          onClick={() => {
                            const next = isExpanded ? null : trade.id;
                            setExpandedId(next);
                            if (next && !indicatorsState[trade.id]) loadIndicators(trade);
                          }}
                          title={isExpanded ? 'Свернуть' : 'Показать историю и индикаторы'}
                        >
                          {isExpanded ? '▾' : '▸'}
                        </button>
                        <span className="font-semibold">{trade.ticker || '—'}</span>
                      </div>
                    </td>
                    <td className="text-secondary" title={`Открыта: ${fmtDateTime(resolveOpenedAt(trade))}${trade.status === 'closed' ? `\nЗакрыта: ${fmtDateTime(resolveClosedAt(trade))}` : ''}`}>
                      {fmtDateTime(resolveOpenedAt(trade) || trade.date)}
                    </td>
                    <td>
                      <span className={`badge ${trade.direction==='long' ? 'badge-green' : 'badge-red'}`}>
                        {trade.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}
                      </span>
                    </td>
                    <td>{formatNumber(trade.entryPrice, 1)}</td>
                    <td>{trade.exitPrice ? formatNumber(trade.exitPrice, 1) : <span className="text-muted">—</span>}</td>
                    <td>
                      {isPartial
                        ? <span title="Осталось открыто / всего было">{formatNumber(trade.remainingVolume, 0)} / {formatNumber(trade.volume, 0)}</span>
                        : (trade.volume ?? '—')}
                    </td>
                    <td>
                      {trade.pnl !== undefined && trade.pnl !== null ? (
                        <span style={{color: trade.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600}}>
                          {trade.pnl >= 0 ? '+' : ''}{formatCurrency(Math.round(trade.pnl))}
                        </span>
                      ) : trade.pnlNeedsSpecs ? (
                        <span className="text-muted" title="Биржа не дала параметры контракта — раскройте сделку, чтобы ввести вручную">⚠️ —</span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      {trade.pnl !== undefined && trade.pnl !== null && deposit ? (
                        <span style={{
                          color: trade.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                          fontWeight: 600, fontSize: 13,
                        }}>
                          {trade.pnl >= 0 ? '+' : ''}{((trade.pnl / deposit) * 100).toFixed(2)}%
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      <span className={`badge ${statusCls}`}>{statusLabel}</span>
                    </td>
                    <td>
                      {/* Stacked, not inline — an open trade's extra "Закрыть" button used to
                          push ✏️/🗑 past the visible table width, and the horizontal-scroll
                          affordance wasn't obvious, so the trash icon looked cut off (real
                          user report). Both rows share the same width and vertical padding
                          now too — they used to be visibly different sizes (real user
                          follow-up report), which read as sloppy even after the overflow fix. */}
                      <div className="flex flex-col gap-1" style={{width:92}}>
                        <div className="flex gap-2" style={{width:'100%'}}>
                          <button className="btn btn-ghost btn-sm" style={{flex:1, padding:'6px 0'}} onClick={() => openEdit(trade)} title="Редактировать">✏️</button>
                          <button className="btn btn-ghost btn-sm" style={{flex:1, padding:'6px 0', color:'var(--red)'}} onClick={() => handleDelete(trade.id)} title="Удалить">🗑</button>
                        </div>
                        {/* Below ✏️/🗑, not above — user report: the extra button should
                            sit under the pair, not push it down. */}
                        {(trade.status === 'open' || trade.status === 'partial') && (
                          <button
                            className="btn btn-sm"
                            style={{
                              width: '100%',
                              background: 'linear-gradient(135deg, #10b981, #059669)',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 8,
                              padding: '6px 0',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                              boxShadow: '0 2px 8px rgba(16,185,129,0.3)',
                            }}
                            onClick={() => openClose(trade)}
                            title="Закрыть сделку"
                          >
                            ✅ Закрыть
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={COLS.length} style={{background:'var(--bg-surface-2)', padding:'12px 16px 16px 44px'}}>
                        {hasHistory && (
                          <>
                            <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:8}}>История сделки — {trade.legs.length} операций</div>
                            <table className="table" style={{fontSize:13, marginBottom:16}}>
                              <thead>
                                <tr>
                                  <th>Время</th><th>Действие</th><th>Объём</th><th>Цена</th><th>Комиссия</th>
                                </tr>
                              </thead>
                              <tbody>
                                {trade.legs.map((leg, i) => (
                                  <tr key={i}>
                                    <td className="text-secondary">{fmtDateTime(leg.timestampUtc)}</td>
                                    <td>
                                      <span className={`badge ${leg.type === 'open' ? 'badge-green' : 'badge-red'}`}>
                                        {leg.type === 'open' ? (leg.side === 'buy' ? 'Докупка' : 'Открытие шорта') : (leg.side === 'sell' ? 'Продажа' : 'Выкуп')}
                                      </span>
                                    </td>
                                    <td>{formatNumber(leg.quantity, 0)}</td>
                                    <td>{formatNumber(leg.price, 2)}</td>
                                    <td className="text-secondary">{formatCurrency(Math.round(leg.commission || 0))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </>
                        )}

                        {trade.strategyMatchAtEntry && (
                          <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:12}}>
                            Совпадение со стратегией на входе: <strong style={{color:'var(--text-primary)'}}>
                              {trade.strategyMatchAtEntry.passed} из {trade.strategyMatchAtEntry.total} ({trade.strategyMatchAtEntry.percent}%)
                            </strong>
                          </div>
                        )}

                        {trade.pnlNeedsSpecs && (
                          <div style={{
                            background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                            borderRadius: 10, padding: '10px 14px', marginBottom: 16,
                          }}>
                            <div style={{fontSize: 13, color: 'var(--gold)', marginBottom: 8}}>
                              ⚠️ Не удалось определить P&L автоматически — биржа не публикует параметры этого
                              контракта (обычно так с мини-фьючерсами или уже неторгуемыми сериями). Введите
                              стоимость 1 пункта цены в рублях (можно посмотреть на странице контракта на
                              Мосбирже) — и мы посчитаем сами.
                            </div>
                            <div className="flex gap-2" style={{alignItems: 'center'}}>
                              <input
                                className="input"
                                type="number"
                                step="0.01"
                                placeholder="₽ за 1 пункт цены"
                                style={{maxWidth: 200}}
                                value={manualStepInput[trade.id] || ''}
                                onChange={(e) => setManualStepInput((s) => ({ ...s, [trade.id]: e.target.value }))}
                              />
                              <button
                                className="btn btn-secondary btn-sm"
                                disabled={savingManualSpec === trade.id}
                                onClick={() => saveManualSpec(trade)}
                              >
                                {savingManualSpec === trade.id ? 'Считаю…' : 'Посчитать P&L'}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Технический анализ на момент входа — module 4. Таймфрейм
                            выбирается прямо в шапке графика (тот же контрол, что в
                            Калькуляторе) — раньше была отдельная строка кнопок над
                            графиком, дублирующая то же самое (real user report). */}
                        {indicatorsState[trade.id]?.data?.candles?.length > 0 && (
                          <div style={{marginBottom: 16}}>
                            <CandleChart
                              candles={indicatorsState[trade.id].data.candles}
                              patterns={indicatorsState[trade.id].data.patterns}
                              ticker={trade.ticker}
                              direction={trade.direction}
                              legs={trade.legs}
                              entryPrice={trade.entryPrice}
                              exitPrice={trade.status === 'closed' ? trade.exitPrice : null}
                              entryMarker={!trade.legs?.length && resolveOpenedAt(trade) ? { date: resolveOpenedAt(trade), price: trade.entryPrice, direction: trade.direction } : null}
                              exitMarker={!trade.legs?.length && trade.status === 'closed' && resolveClosedAt(trade) ? { date: resolveClosedAt(trade), price: trade.exitPrice } : null}
                              timeframe={timeframeFor(trade)}
                              timeframeOptions={availableTimeframes(!!userProfile?.tinkoffToken)}
                              onTimeframeChange={(tf) => changeTimeframe(trade, tf)}
                            />
                            {!tfOverride[trade.id] && (
                              <div style={{fontSize: 11, color: 'var(--text-muted)', marginTop: 4}}>Таймфрейм подобран по длительности сделки</div>
                            )}
                          </div>
                        )}
                        <TechnicalAnalysisBlock
                          state={indicatorsState[trade.id]}
                          onRefresh={() => loadIndicators(trade, true)}
                          title="Технический анализ на момент входа"
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
        )}
      </div>
      )}

      {/* Радар — watchlist of forming setups */}
      {view === 'radar' && (
        <div className="flex flex-col gap-3">
          {radarLoading ? (
            <div className="card empty-state"><div className="spinner" style={{width:28,height:28}}/></div>
          ) : radarItems.length === 0 ? (
            <div className="card empty-state">
              <div className="empty-state-icon">📡</div>
              <div className="empty-state-title">Радар пуст</div>
              <div className="empty-state-text">Добавьте тикер, за которым хотите следить, пока сетап не подтвердится</div>
            </div>
          ) : (
            radarItems.map((item) => {
              const isExpanded = expandedId === `radar-${item.id}`;
              return (
                <div className="card" key={item.id}>
                  <div className="flex justify-between items-center">
                    <div className="flex gap-2" style={{alignItems:'center'}}>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{padding:'2px 6px'}}
                        onClick={() => {
                          const next = isExpanded ? null : `radar-${item.id}`;
                          setExpandedId(next);
                          if (next && !radarState[item.id]) loadRadarAnalysis(item);
                        }}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                      <span className="font-semibold">{item.ticker}</span>
                      <span className="badge badge-blue" style={{fontSize:11}}>
                        {item.instrumentType === 'future' ? 'Фьючерс' : item.instrumentType === 'currency' ? 'Валюта' : 'Акция'}
                      </span>
                      {radarLive && radarResults?.[item.id]?.result?.total > 0 && (() => {
                        const r = radarResults[item.id].result;
                        const pct = Math.round((r.passed / r.total) * 100);
                        return (
                          <span className="badge" style={{fontSize:11, background: pct >= 80 ? 'rgba(16,185,129,0.15)' : pct >= 50 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)', color: pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--red)'}}>
                            {r.passed} из {r.total}
                          </span>
                        );
                      })()}
                      {item.note && <span className="text-muted" style={{fontSize:13}}>{item.note}</span>}
                    </div>
                    <div className="flex gap-2">
                      <button className="btn btn-secondary btn-sm" onClick={() => openFromRadar(item)}>
                        📓 Перенести в журнал
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={() => setConfirmDeleteRadar(item.id)} title="Убрать из радара">🗑</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{marginTop:16, paddingTop:16, borderTop:'1px solid var(--border-subtle)'}}>
                      {radarState[item.id]?.data?.candles?.length > 0 && (
                        <div style={{marginBottom:16}}>
                          <CandleChart
                            candles={radarState[item.id].data.candles}
                            patterns={radarState[item.id].data.patterns}
                            ticker={item.ticker}
                            timeframe={radarTimeframeFor(item)}
                            timeframeOptions={availableTimeframes(!!userProfile?.tinkoffToken)}
                            onTimeframeChange={(tf) => changeRadarTimeframe(item, tf)}
                          />
                        </div>
                      )}
                      <TechnicalAnalysisBlock
                        state={radarState[item.id]}
                        onRefresh={() => loadRadarAnalysis(item, true)}
                        title="Технический анализ сейчас"
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Мини-модал добавления в радар */}
      {addRadarOpen && (
        <div className="modal-overlay" onClick={() => setAddRadarOpen(false)}>
          <div className="modal" style={{maxWidth:400}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">📡 Добавить в радар</h3>
              <button className="modal-close" onClick={() => setAddRadarOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{paddingTop:20, paddingBottom:8}}>
              <div className="input-group">
                <label className="input-label">Тикер *</label>
                <input className="input" value={radarForm.ticker}
                  onChange={e => {
                    const ticker = e.target.value.toUpperCase();
                    setRadarForm(f => ({ ...f, ticker, instrumentType: radarTypeTouched ? f.instrumentType : guessInstrumentType(ticker) }));
                  }}
                  placeholder="SBER" style={{textTransform:'uppercase'}} autoFocus />
              </div>
              <div className="input-group">
                <label className="input-label">Тип инструмента <span className="text-muted" style={{fontWeight:400}}>(определяется автоматически по тикеру)</span></label>
                <select className="input" value={radarForm.instrumentType}
                  onChange={e => { setRadarTypeTouched(true); setRadarForm(f => ({ ...f, instrumentType: e.target.value })); }}>
                  <option value="stock">Акция</option>
                  <option value="future">Фьючерс</option>
                  <option value="currency">Валюта</option>
                </select>
              </div>
              <div className="input-group">
                <label className="input-label">
                  Таймфрейм для проверки условий
                  <span className="text-muted" style={{fontWeight:400}}> (тот же, что вы используете в Калькуляторе для этого тикера)</span>
                </label>
                <select className="input" value={radarForm.timeframe}
                  onChange={e => setRadarForm(f => ({ ...f, timeframe: e.target.value }))}>
                  {availableTimeframes(!!userProfile?.tinkoffToken).map(tf => (
                    <option key={tf.key} value={tf.key}>{tf.label}</option>
                  ))}
                </select>
                <div className="input-hint">
                  Уровни/индикаторы на Д1 и на внутридневном графике — разные цифры. Радар по умолчанию
                  считал на Д1 всегда, из-за чего верно настроенное условие могло выглядеть невыполненным
                  просто не на том горизонте.
                </div>
              </div>
              <div className="input-group">
                <label className="input-label">Заметка</label>
                <input className="input" value={radarForm.note}
                  onChange={e => setRadarForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="Например: жду пробой 280" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setAddRadarOpen(false)}>Отмена</button>
              <button className="btn btn-primary" onClick={handleAddRadar} disabled={!radarForm.ticker.trim()}>Добавить</button>
            </div>
          </div>
        </div>
      )}

      {/* Подтверждение удаления из радара */}
      {confirmDeleteRadar && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteRadar(null)}>
          <div className="modal" style={{maxWidth:360}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Убрать из радара?</h3>
              <button className="modal-close" onClick={() => setConfirmDeleteRadar(null)}>✕</button>
            </div>
            <div style={{padding:'16px 0', color:'var(--text-muted)', fontSize:14, textAlign:'center'}}>
              Тикер и заметка будут удалены из радара.
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setConfirmDeleteRadar(null)}>Отмена</button>
              <button className="btn" onClick={handleDeleteRadar}
                style={{background:'linear-gradient(135deg,#ef4444,#dc2626)', color:'#fff', border:'none'}}>
                🗑 Убрать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Мини-модал быстрого закрытия */}
      {closeModal && (
        <div className="modal-overlay" onClick={() => setCloseModal(null)}>
          {/* Was: extra paddingLeft/Right:24 directly on .modal PLUS its own inline
              padding:'0 4px 8px' on the content wrapper instead of the shared
              .modal-body class — the header/footer's divider borders (inset by
              .modal-header/.modal-footer's own 28px padding + the extra 24px) ended up
              narrower than the input fields below them (inset by only 24+4=28px total),
              a ~24px mismatch that read as the lines being cut short (real user
              report/photo). Using .modal-body like every other modal in the app fixes
              the inset to match on all sides. */}
          <div className="modal" style={{maxWidth:400}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">✅ Закрыть сделку</h3>
              <button className="modal-close" onClick={() => setCloseModal(null)}>✕</button>
            </div>

            <div className="modal-body" style={{paddingTop:20, paddingBottom:8}}>
              {/* Инфо о сделке */}
              <div style={{
                background:'rgba(79,70,229,0.08)',
                border:'1px solid rgba(79,70,229,0.2)',
                borderRadius:12,
                padding:'12px 16px',
                marginBottom:20,
              }}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Тикер</span>
                  <span style={{fontWeight:700,color:'var(--accent-primary)'}}>{closeModal.ticker}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Цена входа</span>
                  <span style={{fontWeight:600}}>{formatNumber(closeModal.entryPrice, 2)}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Объём</span>
                  <span style={{fontWeight:600}}>{closeModal.volume} конт.</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Направление</span>
                  <span style={{color: closeModal.direction==='long' ? 'var(--green)' : 'var(--red)', fontWeight:600}}>
                    {closeModal.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}
                  </span>
                </div>
              </div>

              {/* Поле цены выхода */}
              <div style={{marginBottom:4}}>
                <label style={{
                  display:'block', fontSize:11, fontWeight:500,
                  color:'rgba(255,255,255,0.4)', letterSpacing:'0.3px',
                  marginBottom:4, paddingLeft:4,
                }}>
                  Цена выхода *
                </label>
                <div style={{
                  display:'flex', alignItems:'center',
                  background:'rgba(255,255,255,0.05)',
                  border:'1px solid rgba(79,70,229,0.4)',
                  borderRadius:10, overflow:'hidden',
                  boxShadow:'0 0 0 2px rgba(79,70,229,0.1)',
                }}>
                  <input
                    type="number"
                    step="any"
                    placeholder="Цена закрытия"
                    value={closePrice}
                    onChange={e => setClosePrice(e.target.value)}
                    autoFocus
                    style={{
                      flex:1, background:'none', border:'none', outline:'none',
                      padding:'9px 12px',
                      fontSize:13, fontFamily:'inherit',
                      color:'#f0f4ff', fontWeight:600,
                    }}
                  />
                </div>
              </div>

              {/* Время закрытия */}
              <div style={{marginTop:12, marginBottom:4}}>
                <label style={{
                  display:'block', fontSize:11, fontWeight:500,
                  color:'rgba(255,255,255,0.4)', letterSpacing:'0.3px',
                  marginBottom:4, paddingLeft:4,
                }}>
                  Время закрытия
                </label>
                <input
                  type="datetime-local"
                  value={closedAt}
                  onChange={e => setClosedAt(e.target.value)}
                  className="input"
                  style={{width:'100%'}}
                />
              </div>

              {/* Предпросмотр P&L */}
              {quickResult && (
                <div style={{
                  marginTop:16,
                  padding:'12px 16px',
                  background: quickResult.pnl >= 0 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${quickResult.pnl >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  borderRadius:12,
                }}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                    <span style={{color:'var(--text-muted)',fontSize:12}}>P&L (с комиссией)</span>
                    <span style={{
                      fontWeight:700,
                      fontSize:16,
                      color: quickResult.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                    }}>
                      {quickResult.pnl >= 0 ? '+' : ''}{formatCurrency(quickResult.pnl)}
                    </span>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between'}}>
                    <span style={{color:'var(--text-muted)',fontSize:12}}>Комиссия</span>
                    <span style={{color:'var(--text-muted)',fontSize:12}}>{formatCurrency(quickResult.commission)}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer" style={{marginTop:20}}>
              <button className="btn btn-ghost" onClick={() => setCloseModal(null)}>Отмена</button>
              <button
                className="btn btn-primary"
                onClick={handleQuickClose}
                disabled={!closePrice || closing}
                style={{background:'linear-gradient(135deg,#10b981,#059669)'}}
              >
                {closing ? 'Закрываем...' : '✅ Закрыть сделку'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Кастомный модал подтверждения удаления */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" style={{maxWidth:360}} onClick={e => e.stopPropagation()}>
            <div className="modal-header" style={{borderBottom:'1px solid rgba(239,68,68,0.2)'}}>
              <h3 className="modal-title" style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{
                  width:32,height:32,borderRadius:'50%',
                  background:'rgba(239,68,68,0.15)',
                  display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,
                }}>🗑</span>
                Удалить сделку?
              </h3>
              <button className="modal-close" onClick={() => setConfirmDelete(null)}>✕</button>
            </div>
            <div style={{padding:'16px 0', color:'var(--text-muted)', fontSize:14, lineHeight:1.6, textAlign:'center'}}>
              Это действие нельзя отменить. Сделка будет удалена из журнала навсегда.
            </div>
            <div className="modal-footer" style={{marginTop:8}}>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>
                Отмена
              </button>
              <button
                className="btn"
                onClick={handleConfirmDelete}
                style={{
                  background:'linear-gradient(135deg,#ef4444,#dc2626)',
                  color:'#fff', border:'none',
                  boxShadow:'0 4px 12px rgba(239,68,68,0.3)',
                }}
              >
                🗑 Удалить
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <TradeModal
          trade={editTrade}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditTrade(null); }}
          defaultDeposit={userProfile?.depositSize}
        />
      )}

      {importOpen && (
        <ImportModal
          existingTrades={trades}
          onClose={() => setImportOpen(false)}
          onImported={async () => { setImportOpen(false); await load(); }}
        />
      )}
    </div>
  );
}
