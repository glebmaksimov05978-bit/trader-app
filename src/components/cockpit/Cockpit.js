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
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { addTrade, getUserTrades, resolveOpenedAt } from '../../services/trades';
import { getOpenPaperTrades, getPaperTrades, updatePaperTrade } from '../../services/paperTrades';
import { groupPaperByStrategy, paperStrategyKey } from '../../services/analytics/paperGroups';
import Icon from '../shared/Icon';
import { fetchDailyCandles, availableTimeframes } from '../../services/marketData/candles';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { catalogEntry } from '../../services/marketData/instrumentCatalog';
import TechnicalAnalysisBlock from '../shared/TechnicalAnalysisBlock';
import StrategyChecklist from '../shared/StrategyChecklist';
import { getActiveStrategy, getStrategies, evaluateStrategy } from '../../services/analytics/strategy';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';
import { commissionRateFor, DEFAULT_TARIFF } from '../../services/analytics/commission';
import { computeBaskets, getPortfolio } from '../../services/analytics/portfolio';
import { formatCurrency } from '../../utils/calculator';
import { computeBothLines, computeLiveState } from '../../services/backtest/livePosition';
import { computeProfitBreakdown, computeLossBreakdown } from '../../services/backtest/engine';
import { evaluateAlerts, DEFAULT_ALERT_PREFS } from '../../services/alerts';
import { loadBacktestSample, findSimilar, probabilityOfGoal } from '../../services/backtest/similarTrades';
import { applyTradeClose } from '../../services/tradeClose';
import { fetchOrderConfig, fetchOrderState } from '../../services/broker';
import { reconcilePendingTrades } from '../../services/pendingOrders';
import { updateTrade } from '../../services/trades';
import CandleChart from '../shared/CandleChart';
import RadarPanel from './RadarPanel';
import StrategyOverview from './StrategyOverview';
import { useRadarLive } from '../../context/RadarLiveContext';
import CollapsibleSection from './CollapsibleSection';
import OrderModal from '../calculator/OrderModal';
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
  // Штраф «слишком рано» на свежей сделке может увести счёт в минус — это верно для
  // сравнения с порогом (см. reached, который приходит уже посчитанным по сырому score),
  // но «−1 из 4» крупным числом читается как поломка. В самом разборе ниже штраф всё равно
  // виден отдельной строкой, так что смысл не теряется — просто заголовок не пугает.
  const displayScore = score == null ? '—' : Math.max(0, score);
  return (
    <div className="ck-panel ck-score">
      <div className="ck-score-head">
        <div>
          <h3>{title}</h3>
          <div className="ck-hint">{hint}</div>
        </div>
        <div className={`ck-score-num ${reached ? tone : ''}`}>
          {displayScore}<small>/{threshold}</small>
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
        {!breakdown?.length && <div className="ck-empty">Разбор появится, когда пройдёт хотя бы один бар после входа.</div>}
      </div>
    </div>
  );
}

export default function Cockpit() {
  const { user, userProfile, updateUserProfile } = useAuth();
  const navigate = useNavigate();
  const [trades, setTrades] = useState([]);
  // Корзины портфеля считаются по ВСЕМ сделкам, а не только открытым: результат корзины —
  // это в первую очередь уже закрытые сделки. Открытые лежат в `trades` отдельно, потому
  // что вкладка ведёт именно их.
  const [allTrades, setAllTrades] = useState([]);
  // Бумажные сделки лежат в своей коллекции и в статистику не попадают — см. шапку
  // services/paperTrades.js. Здесь они нужны только чтобы их можно было вести и смотреть.
  const [paperTrades, setPaperTrades] = useState([]);
  // Все бумажные (и закрытые) — только для сводки по стратегиям над списком: сколько каждая
  // уже закрыла и с каким итогом. Ведутся по-прежнему только открытые (paperTrades).
  const [allPaper, setAllPaper] = useState([]);
  // Какую стратегию показывать в списке бумажных: 'all' или ключ стратегии.
  const [paperFilter, setPaperFilter] = useState('all');
  // Режим Сопровождения: 'all' — общий обзор, иначе id стратегии. Режим стратегии сужает всё сразу:
  // радар, бумажные и открытые позиции показывают только её, а вкладка ведёт сделки по её правилам.
  const [scopeId, setScopeId] = useState('all');
  const [radarItems, setRadarItems] = useState([]);
  const radarLive = useRadarLive();
  // Переход из Радара может указывать конкретную сделку (обычно бумажную, которую уже
  // ведёт система) — ?activeId=... в ссылке. Читается один раз при заходе на вкладку;
  // эффекты ниже, загружающие настоящие/бумажные сделки, не перезатирают уже заданный
  // activeId (там стоит `cur || ...`), так что порядок загрузки не важен.
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeId, setActiveId] = useState(() => searchParams.get('activeId') || null);
  // Клик по инструменту в радаре, у которого система ЕЩЁ ничего не открыла (нет условий
  // или бумажная сделка ещё не завелась) — раньше вёл прямиком в Калькулятор, реальная
  // просьба трейдера: показывать график и технический анализ прямо здесь, в привычном
  // оформлении Сопровождения, а в Калькулятор вести только по явному нажатию, если решил
  // сам открыть сделку. ?previewTicker=... задаёт это ровно так же, как ?activeId=...
  const previewTicker = searchParams.get('previewTicker');
  const previewType = searchParams.get('previewType') || 'stock';
  const urlActiveId = searchParams.get('activeId');
  // Радар живёт ВНУТРИ этой же вкладки, поэтому клик по нему меняет только адрес, а сама
  // вкладка не перемонтируется — начальное значение useState читается один раз и новую
  // ссылку не увидело бы (клик по тикеру «не работал», пока не уйдёшь на другую вкладку и
  // не вернёшься). Состояние синхронизируется с адресом при каждом его изменении.
  useEffect(() => { if (urlActiveId) setActiveId(urlActiveId); }, [urlActiveId]);
  useEffect(() => { if (previewTicker) setActiveId(null); }, [previewTicker, previewType]);
  // Выбор сделки в списке слева убирает предпросмотр из адреса: иначе повторный клик по
  // тому же тикеру в радаре не менял бы адрес и не вернул бы предпросмотр обратно.
  const selectTrade = (id) => {
    setActiveId(id);
    if (previewTicker || urlActiveId) setSearchParams({}, { replace: true });
  };
  // Технический анализ: одна кнопка и одна панель на оба режима — и когда сделка открыта,
  // и когда просто смотришь инструмент из радара. Сами данные грузятся по нажатию.
  const [taOpen, setTaOpen] = useState(false);
  const [taTf, setTaTf] = useState(null);
  const [taState, setTaState] = useState({ loading: false, data: null, error: null });
  const [previewDir, setPreviewDir] = useState(null); // 'long' | 'short' | null = какая ближе
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
  // Настоящая заявка на фиксацию — та же механика, что «Купить сразу» в Калькуляторе,
  // только в обратную сторону (закрытие вместо открытия). Раньше «Зафиксировать в
  // Журнале» просто переносило трейдера в Журнал с подставленным объёмом — цену он
  // всё равно вводил на глаз, и было неочевидно, фиксируется сделка НА САМОМ ДЕЛЕ
  // (через брокера) или это просто запись в журнале задним числом.
  const [orderCfg, setOrderCfg] = useState(null);
  // fetchOrderConfig отдаёт null и когда конфиг ещё грузится, и когда сервер недоступен/не
  // настроен — раньше эти два случая было не различить, и при реальном сбое (сервер не
  // ответил) кнопка молнии молча исчезала НАВСЕГДА без единого слова объяснения (реальная
  // жалоба: «кнопки нет и пояснения тоже нет»). Явный флаг "запрос завершён" разводит их.
  const [orderCfgLoaded, setOrderCfgLoaded] = useState(false);
  const [closeOrder, setCloseOrder] = useState(null); // { lots, side } — что фиксируем сейчас
  // Повтор бумажной сделки настоящей заявкой — { lots }. Единственный путь, которым
  // бумажная сделка превращается в реальную позицию, и только по явному нажатию человека.
  const [repeatOrder, setRepeatOrder] = useState(null);

  useEffect(() => { loadBacktestSample().then(setSample); }, []);

  useEffect(() => {
    if (!user) { setOrderCfg(null); setOrderCfgLoaded(false); return; }
    setOrderCfgLoaded(false);
    fetchOrderConfig(userProfile).then((cfg) => { setOrderCfg(cfg); setOrderCfgLoaded(true); });
  }, [user, userProfile]);

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
  const chooseScope = (id) => {
    setScopeId(id);
    setPaperFilter(id);
    if (id !== 'all') setStrategyId(id);
    // Выбранная сделка могла быть чужой стратегии — сбрасываем, чтобы режим не показывал лишнего.
    setActiveId(null);
    if (previewTicker || urlActiveId) setSearchParams({}, { replace: true });
  };

  // Выбрали сделку — вкладка сразу ведёт её по ТОЙ стратегии, которой она открыта. Раньше
  // оставалась последняя выбранная вручную, и сделка краткосрочной стратегии считалась по
  // правилам долгосрочной (одинаковые цифры при «переключении» — именно отсюда). Переключить
  // на другую стратегию для примерки по-прежнему можно — эффект срабатывает только при смене сделки.
  const activeEntryStrategyId = (trades.find((t) => t.id === activeId) || paperTrades.find((t) => t.id === activeId))?.entryStrategyId;
  useEffect(() => {
    if (activeEntryStrategyId && strategies.some((x) => x.id === activeEntryStrategyId)) setStrategyId(activeEntryStrategyId);
  }, [activeId, activeEntryStrategyId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        let all = await getUserTrades(user.uid);
        // Ожидавшие заявки: сверка с брокером (подробности — services/pendingOrders.js).
        if (all.some((x) => x.status === 'pending' || x.pendingClose)) {
          try {
            const r = await reconcilePendingTrades({
              trades: all, userProfile,
              fetchState: (o) => fetchOrderState(userProfile, o),
              updateTrade, applyClose: applyTradeClose,
            });
            if (r.changed > 0) all = await getUserTrades(user.uid);
          } catch { /* необязательно */ }
        }
        const open = all.filter((t) => t.status === 'open' || t.status === 'partial');
        setTrades(open);
        setAllTrades(all);
        // Зашли по ссылке из радара на инструмент без сделки — не подсовываем вместо него
        // первую попавшуюся открытую позицию.
        // Стартовый экран — «Обзор» по стратегиям, а не первая попавшаяся открытая позиция:
        // сделку выбирают из списка слева (или переходом по ссылке из радара/Telegram).
        setActiveId((cur) => cur || null);
      } catch (e) {
        toast.error('Не удалось загрузить сделки');
      } finally {
        setLoading(false);
      }
    })();
    // previewTicker читается один раз при заходе — перезагружать сделки при каждом клике
    // по радару незачем (лишние чтения базы).
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Грузятся отдельно от настоящих: если чтение упадёт (например, коллекции в базе ещё
  // нет), вкладка должна продолжить вести реальные позиции, а не остаться пустой.
  useEffect(() => {
    if (!user) { setPaperTrades([]); return; }
    getOpenPaperTrades(user.uid).then(setPaperTrades).catch(() => setPaperTrades([]));
    getPaperTrades(user.uid).then(setAllPaper).catch(() => setAllPaper([]));
  }, [user]);

  // Сколько тикеров смотрит каждая стратегия и сколько «горячих» (готовность не ниже порога).
  const radarByStrategy = useMemo(() => {
    const active = getActiveStrategy(userProfile);
    const out = {};
    for (const it of radarItems) {
      const st = (it.strategyId && strategies.find((x) => x.id === it.strategyId)) || active;
      if (!st) continue;
      const row = out[st.id] || (out[st.id] = { total: 0, hot: 0 });
      row.total += 1;
      const r = radarLive?.radarResults?.[it.id]?.result;
      if (r?.total && (r.passed / r.total) * 100 >= (st.readinessThreshold ?? 100)) row.hot += 1;
    }
    return out;
  }, [radarItems, strategies, radarLive?.radarResults, userProfile]);

  // Бумажные по стратегиям: у каждой стратегии свой горизонт (краткосрок, среднесрок…), их не
  // сравнивают друг с другом, а смотрят по отдельности — отсюда вкладки и сводка над списком.
  const paperGroups = useMemo(() => groupPaperByStrategy(allPaper.length ? allPaper : paperTrades), [allPaper, paperTrades]);
  const visiblePaper = paperFilter === 'all' ? paperTrades
    : paperTrades.filter((t) => paperStrategyKey(t) === paperFilter);
  const filterGroup = paperFilter === 'all' ? paperGroups.total : paperGroups.groups.find((g) => g.key === paperFilter);

  // Активной может быть и бумажная сделка: движок ведёт её тем же кодом, что и настоящую,
  // — в этом и смысл, иначе сравнивать было бы не с чем.
  const trade = useMemo(
    () => trades.find((t) => t.id === activeId) || paperTrades.find((t) => t.id === activeId) || null,
    [trades, paperTrades, activeId],
  );
  // Бумажная сделка или настоящая — различие принципиальное, а не косметическое: у
  // бумажной в рынке НЕТ позиции. Всё, что закрывает сделку настоящей заявкой брокеру или
  // пишет фиксацию в коллекцию trades, для неё недопустимо (см. canOrderClose ниже).
  const isPaper = !!trade && (trade.paper === true || paperTrades.some((p) => p.id === trade.id));
  const timeframe = tfOverride || trade?.entryTimeframe || userProfile?.preferredTimeframe || 'H1';

  // Технический анализ — по инструменту открытой сделки или по инструменту из радара.
  // Та же тройка функций, что считает «Технический анализ сейчас» в радаре Журнала и в
  // Калькуляторе, поэтому цифры везде читаются одинаково.
  const taTicker = trade ? trade.ticker : previewTicker;
  const taType = trade ? (trade.instrumentType || 'stock') : previewType;
  const loadTa = useCallback(async (tfArg) => {
    if (!taTicker) return;
    const tf = tfArg || taTf || trade?.entryTimeframe || userProfile?.preferredTimeframe || 'D1';
    setTaState({ loading: true, data: null, error: null });
    try {
      const now = new Date();
      const cs = await fetchDailyCandles({
        ticker: taTicker, instrumentType: taType, toDate: now,
        tinkoffToken: userProfile?.tinkoffToken, timeframe: tf,
      });
      const indicators = computeIndicatorsAtEntry(cs, now);
      const patternsNow = computePatternsAtEntry(cs, now);
      const marketContext = computeMarketContextAtEntry(cs, now);
      if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
      setTaState({ loading: false, data: { indicators, patterns: patternsNow, marketContext, candles: cs }, error: null });
    } catch (e) {
      setTaState({ loading: false, data: null, error: e.message || 'Не удалось загрузить данные' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taTicker, taType, taTf, userProfile, trade]);

  // Сменился инструмент — старый анализ уже не про него. В предпросмотре график строится
  // из этих же данных, поэтому грузим сразу; при открытой сделке — только когда нажали кнопку.
  useEffect(() => {
    setTaState({ loading: false, data: null, error: null });
    setTaTf(null);
    setPreviewDir(null);
    if (taTicker && (!trade || taOpen)) loadTa(null);
  }, [taTicker, taType]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (trade && taOpen && !taState.data && !taState.loading && taTicker) loadTa(null);
  }, [taOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Готовность к входу по условиям стратегии — вместо профит-/лосс-систем, которым без
  // открытой позиции нечего оценивать (они считают пик, просадку и число баров с входа).
  // Условия входа те же, что проверяет робот и что показывает Калькулятор.
  const previewReady = useMemo(() => {
    if (trade || !taState.data || !strategy) return null;
    if (!(strategy.conditions?.length || strategy.customConditions?.length)) return null;
    const cs = taState.data.candles;
    const lastClose = cs?.[cs.length - 1]?.close ?? null;
    const run = (direction) => evaluateStrategy(strategy, {
      indicators: taState.data.indicators,
      patterns: taState.data.patterns,
      marketContext: taState.data.marketContext,
      direction,
      // Плана входа ещё нет — условия, привязанные к цене, судятся по последней цене.
      plan: { rr: null, riskPercent: null, marginUsagePercent: null, entryPrice: lastClose },
      manualChecks: {},
    });
    return { long: run('long'), short: run('short') };
  }, [trade, taState.data, strategy]);

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
        // stopIsSizingOnly — число из Калькулятора для расчёта объёма (ATR-порог, у
        // стратегии стоп сознательно выключен), не заявка на выход. Передать её сюда как
        // stopPrice значило бы заставить движок закрывать сделку по касанию этой цены —
        // ровно то сочетание («ATR-стоп поверх следящего выхода»), которое проверено и
        // оказалось хуже, чем стопа не иметь вовсе.
        stopPrice: (trade.stopLoss && !trade.stopIsSizingOnly) ? parseFloat(trade.stopLoss) : null,
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

  // Раз в минуту обновляем позицию сами, пока вкладка на виду, — раньше цены и итог
  // менялись только по кнопке «⟳ Обновить». С токеном Т-Банка свечи уже идут оттуда
  // (fetchDailyCandles выше), без токена — с Мосбиржи с задержкой ~15 минут.
  useEffect(() => {
    if (!trade) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') recompute();
    }, 60000);
    return () => clearInterval(id);
  }, [trade, recompute]);

  // Где система закрыла бы позицию (целиком или частями) — метки на графике рядом с реальными
  // операциями. Берутся из теневой линии: движок исполняет там каждый свой сигнал. У бумажной
  // сделки метки не нужны — её и так ведёт система, реальные операции там не с чем сравнивать.
  const systemMarkers = useMemo(() => {
    const sh = state?.shadow;
    if (isPaper || !sh || !candles?.length) return null;
    const out = [];
    const seen = new Set();
    const add = (index, text) => {
      const c = candles[index];
      if (!c || seen.has(index)) return;
      seen.add(index);
      out.push({ date: c.date, text });
    };
    (sh.fired || []).forEach((f) => add(f.index, f.fraction >= 0.999 ? 'Система: выход' : 'Система: часть'));
    if (sh.exit) add(sh.exit.index, 'Система: выход');
    return out.length ? out : null;
  }, [state, candles, isPaper]);

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

  // Настоящей заявкой можно закрывать только то, что вообще можно купить/продать через
  // воркер: тикер разрешён (белый список или явный "*" на сервере), счета резолвятся.
  // Иначе кнопки просто нет — остаётся обычный путь через Журнал. Но молчать о ПРИЧИНЕ
  // нельзя: реальная жалоба — «снова не вижу кнопки фиксации» — оказалась именно этим:
  // тикер (фьючерс IMOEXF) не входил в белый список сервера, где были только акции.
  const tickerOrderable = !!(orderCfg?.enabled && trade?.ticker
    && (orderCfg.wildcard || orderCfg.whitelist?.includes(trade.ticker.toUpperCase())));
  // Закрывать настоящей заявкой можно только НАСТОЯЩУЮ позицию. У бумажной сделки в рынке
  // ничего нет: «Зафиксировать» по ней отправило бы брокеру реальную продажу бумаги,
  // которой у трейдера нет (а для шорта — покупку), и следом попыталось бы записать
  // фиксацию в trades по id из совсем другой коллекции. Поэтому у бумажных сделок кнопок
  // фиксации нет вовсе — вместо них «Повторить реальной заявкой», то есть ОТКРЫТИЕ.
  const canOrderClose = tickerOrderable && !isPaper;
  const canOrderRepeat = tickerOrderable && isPaper;
  const orderUnavailableReason = !trade || isPaper || canOrderClose ? null
    : !orderCfgLoaded ? null // конфиг ещё грузится — рано делать вывод
      : !orderCfg ? 'Не удалось получить настройки отправки заявок с сервера — заявку по этой сделке можно только записать вручную.'
        : !orderCfg.enabled ? 'Отправка заявок не настроена (см. Настройки → Отправка заявок брокеру).'
          : `${trade.ticker} нет в белом списке разрешённых инструментов на сервере — заявку по нему отправить нельзя, только записать вручную.`;
  // Почему кнопки повтора нет — те же причины, но формулировки про открытие, а не фиксацию.
  const repeatUnavailableReason = !isPaper || canOrderRepeat ? null
    : !orderCfgLoaded ? null
      : !orderCfg ? 'Не удалось получить настройки отправки заявок с сервера — повторить такую сделку можно только руками в приложении брокера.'
        : !orderCfg.enabled ? 'Отправка заявок не настроена (см. Настройки → Отправка заявок брокеру).'
          : `${trade.ticker} нет в белом списке разрешённых инструментов на сервере — заявку по нему отправить нельзя.`;

  const openCloseOrder = (lots) => {
    const l = Math.max(1, Math.round(lots));
    if (l < 1) return;
    setCloseOrder({ lots: l });
  };

  // Заявка на закрытие исполнилась → пишем фиксацию тем же кодом, что и ручное закрытие
  // в Журнале (services/tradeClose.js), только цена и объём — РЕАЛЬНЫЕ, из ответа
  // брокера, а не введённые на глаз.
  const handleCloseOrderPlaced = async (res) => {
    const lotsExecuted = res?.order?.lotsExecuted;
    const executedPrice = res?.order?.executedPrice;
    if (!(lotsExecuted > 0) || executedPrice == null) {
      // Закрывающая заявка принята, но ещё не исполнена: отмечаем её на сделке — по исполнению
      // приложение само закроет (services/pendingOrders.js), а не потеряет.
      if (trade && res?.order?.orderId) {
        try {
          await updateTrade(trade.id, { pendingClose: { orderId: res.order.orderId, accountId: res?.preview?.accountId || null, lots: res?.preview?.lots ?? null, placedAt: new Date().toISOString() } });
          toast.success('Заявка на закрытие ждёт исполнения — приложение само закроет сделку, когда она исполнится');
        } catch { /* отметка не критична */ }
      }
      return;
    }
    if (!trade) return;
    try {
      const commRate = parseFloat(trade.commissionRate)
        || commissionRateFor(userProfile?.brokerTariff || DEFAULT_TARIFF, trade.instrumentType || 'stock').rate;
      const { partial, remaining, pnl } = await applyTradeClose({
        trade, exitPrice: executedPrice, qty: lotsExecuted, closedAtDate: new Date(),
        commRate, userProfile, source: 'order',
      });
      const money2 = `${pnl >= 0 ? '+' : ''}${pnl.toLocaleString('ru-RU')} ₽`;
      toast.success(partial
        ? `Зафиксировано ${lotsExecuted}: ${money2}. В рынке осталось ${remaining}.`
        : `Сделка закрыта. P&L: ${money2}`);
      const all = await getUserTrades(user.uid);
      const open = all.filter((t) => t.status === 'open' || t.status === 'partial');
      setTrades(open);
      setAllTrades(all);
      if (!open.some((t) => t.id === activeId)) setActiveId(open[0]?.id || null);
    } catch (e) {
      toast.error(e.message || 'Заявка исполнилась, но запись в Журнал не удалась — зафиксируйте вручную');
    }
  };

  // Повторить бумажную сделку своей, настоящей заявкой. Объём берётся тот же, что у
  // бумажной, — он посчитан по риску от РЕАЛЬНОГО капитала трейдера (calcTrade теми же
  // функциями, что и Калькулятор), так что подставлять что-то своё тут не нужно.
  // Исключение — riskTooBig: там объём условный, и об этом рядом с кнопкой сказано прямо.
  const openRepeatOrder = () => {
    const lots = Math.max(1, Math.round(parseFloat(trade?.volume) || 0));
    if (!(lots >= 1)) return;
    setRepeatOrder({ lots });
  };

  // Заявка на повтор исполнилась → в Журнале появляется НАСТОЯЩАЯ сделка трейдера. Сама
  // бумажная при этом продолжает жить своей жизнью: её ведёт и закроет робот по своим
  // правилам — в этом и смысл эксперимента, сравнить его решения со своими. Поэтому
  // бумажная не закрывается и не удаляется, а только помечается «повторена».
  const handleRepeatOrderPlaced = async (res) => {
    const lotsExecuted = res?.order?.lotsExecuted;
    const executedPrice = res?.order?.executedPrice;
    if (!(lotsExecuted > 0) || executedPrice == null) {
      // Повтор принят, но не исполнен: в Журнал ложится запись «ждёт исполнения».
      if (trade && res?.order?.orderId) {
        try {
          await addTrade(user.uid, {
            ticker: trade.ticker.toUpperCase(),
            date: new Date().toISOString().split('T')[0],
            openedAt: new Date().toISOString(),
            status: 'pending',
            direction: trade.direction === 'short' ? 'short' : 'long',
            entryPrice: res?.preview?.price ?? parseFloat(trade.entryPrice) ?? null,
            intendedEntryPrice: parseFloat(trade.entryPrice) || null,
            exitPrice: null,
            stopLoss: trade.stopLoss ?? null,
            takeProfit: trade.takeProfit ?? null,
            volume: res?.preview?.lots ?? parseFloat(trade.volume) ?? 1,
            lot: parseFloat(trade.lot) || 1,
            instrumentType: trade.instrumentType || 'stock',
            isFuture: (trade.instrumentType || 'stock') === 'future',
            minStep: parseFloat(trade.minStep) || null,
            minStepAmount: parseFloat(trade.minStepAmount) || null,
            commissionRate: parseFloat(trade.commissionRate) || null,
            pnl: null,
            source: 'paper-repeat',
            orderId: res.order.orderId,
            orderAccountId: res?.preview?.accountId || null,
            pendingOrder: { orderId: res.order.orderId, accountId: res?.preview?.accountId || null, lots: res?.preview?.lots ?? null, price: res?.preview?.price ?? null, placedAt: new Date().toISOString() },
            entryTimeframe: trade.entryTimeframe || null,
            entryStrategyId: trade.entryStrategyId || null,
            entryStrategyName: trade.entryStrategyName || null,
            repeatedFromPaperId: trade.id,
          });
          toast.success('Заявка ждёт исполнения — записана в Журнал с пометкой, приложение само проверит её');
        } catch { /* запись не критична — заявка у брокера */ }
      }
      return;
    }
    if (!trade) return;
    const openedAtDate = new Date();
    const lot = parseFloat(trade.lot) || 1;
    const commRate = parseFloat(trade.commissionRate)
      || commissionRateFor(userProfile?.brokerTariff || DEFAULT_TARIFF, trade.instrumentType || 'stock').rate;
    try {
      await addTrade(user.uid, {
        ticker: trade.ticker.toUpperCase(),
        date: openedAtDate.toISOString().split('T')[0],
        openedAt: openedAtDate.toISOString(),
        status: 'open',
        direction: trade.direction === 'short' ? 'short' : 'long',
        entryPrice: executedPrice,
        // Цена бумажной сделки — это ПЛАН (открытие бара, на котором сошлись условия), а
        // исполнилось по своей цене и, как правило, позже. Разбор сделки сможет честно
        // сравнить одно с другим, а не подменить факт планом.
        intendedEntryPrice: parseFloat(trade.entryPrice) || null,
        exitPrice: null,
        stopLoss: trade.stopLoss ?? null,
        takeProfit: trade.takeProfit ?? null,
        volume: lotsExecuted,
        lot,
        instrumentType: trade.instrumentType || 'stock',
        isFuture: (trade.instrumentType || 'stock') === 'future',
        minStep: parseFloat(trade.minStep) || null,
        minStepAmount: parseFloat(trade.minStepAmount) || null,
        commissionRate: commRate,
        commission: Math.round(executedPrice * lotsExecuted * lot * commRate * 2),
        depositSize: parseFloat(userProfile?.depositSize) || 0,
        pnl: null,
        source: 'paper-repeat',
        orderId: res?.order?.orderId || null,
        orderAccountId: res?.preview?.accountId || null,
        entryTimeframe: trade.entryTimeframe || null,
        entryStrategyId: trade.entryStrategyId || null,
        entryStrategyName: trade.entryStrategyName || null,
        strategyMatchAtEntry: trade.entryTotal
          ? { passed: trade.entryPassed ?? null, total: trade.entryTotal, percent: trade.entryPercent ?? null }
          : null,
        // Из какой бумажной сделки повторено — чтобы позже можно было сравнить пару
        // «система вошла тогда-то по такой цене / я повторил тогда-то по такой».
        repeatedFromPaperId: trade.id,
      });
      try {
        await updatePaperTrade(trade.id, { repeatedAt: openedAtDate.toISOString() });
      } catch { /* отметка не критична — сделка в Журнале уже есть, это главное */ }
      toast.success(`Записано в Журнал: ${lotsExecuted} по ${executedPrice}`);
      const all = await getUserTrades(user.uid);
      setTrades(all.filter((t) => t.status === 'open' || t.status === 'partial'));
      setAllTrades(all);
      getOpenPaperTrades(user.uid).then(setPaperTrades).catch(() => {});
    } catch (e) {
      toast.error(e.message || 'Заявка исполнилась, но записать в Журнал не удалось — заведите сделку вручную');
    }
  };

  // CandleChart ждёт ОБЪЕКТЫ {key, label, ...} — Журнал передаёт именно их через
  // availableTimeframes. Здесь раньше передавались строки ('M5', 'H1', …), поэтому
  // tf.key был undefined: над графиком рисовались пустые кнопки без подписи, и нажатие
  // на них ничего не переключало (реальная жалоба: «пять непонятных пустых окошек»).
  const tfOptions = useMemo(
    () => availableTimeframes(!!userProfile?.tinkoffToken),
    [userProfile?.tinkoffToken],
  );

  // --- корзины портфеля ---
  // Раньше портфель жил только в Капитале: чтобы посмотреть, сколько выделено стратегии и
  // как она идёт, приходилось уходить с вкладки и возвращаться (запрос трейдера — держать
  // это рядом с позициями). Расчёт тот же самый, computeBaskets, второго источника правды
  // не заводим.
  const baskets = useMemo(
    () => computeBaskets({ userProfile, strategies, trades: allTrades }),
    [userProfile, strategies, allTrades],
  );
  const [newBasketId, setNewBasketId] = useState('');
  const [newBasketPct, setNewBasketPct] = useState('');
  const [savingBasket, setSavingBasket] = useState(false);

  const savePortfolio = async (next) => {
    setSavingBasket(true);
    try {
      await updateUserProfile({ portfolio: next });
    } catch {
      toast.error('Не удалось сохранить портфель');
    } finally {
      setSavingBasket(false);
    }
  };

  // Плюсик добавляет стратегию в портфель и спрашивает её долю. Первая же добавленная
  // корзина включает режим — отдельная галочка «включить» здесь была бы лишним шагом.
  const addBasket = async () => {
    const pct = parseFloat(newBasketPct);
    if (!newBasketId || !(pct > 0)) { toast.error('Выберите стратегию и укажите процент'); return; }
    const cur = getPortfolio(userProfile);
    const rest = cur.baskets.filter((b) => b.strategyId !== newBasketId);
    await savePortfolio({ enabled: true, baskets: [...rest, { strategyId: newBasketId, sharePct: pct }] });
    setNewBasketId('');
    setNewBasketPct('');
  };

  const removeBasket = async (strategyId) => {
    const cur = getPortfolio(userProfile);
    await savePortfolio({ ...cur, baskets: cur.baskets.filter((b) => b.strategyId !== strategyId) });
  };

  // --- третья линия: как эту же сделку вела бы ДРУГАЯ стратегия ---
  // Две основные линии отвечают на вопрос «слушался я движка или нет». Эта отвечает на
  // другой: «а стоило ли вообще вести сделку по этим правилам». Считается тем же движком,
  // на тех же свечах и с тем же баром входа — меняются только правила выхода, режим
  // shadow (движок исполняет каждый свой сигнал).
  const [compareId, setCompareId] = useState('');
  const compareStrategy = useMemo(
    () => strategies.find((s) => s.id === compareId) || null,
    [strategies, compareId],
  );
  const compareLine = useMemo(() => {
    if (!compareStrategy || !trade || !candles?.length || state?.entryIndex == null) return null;
    try {
      return computeLiveState({
        candles,
        entryIndex: state.entryIndex,
        direction: trade.direction === 'short' ? 'short' : 'long',
        entryPrice: parseFloat(trade.entryPrice),
        rules: compareStrategy.exitRules || {},
        // stopIsSizingOnly — число из Калькулятора для расчёта объёма (ATR-порог, у
        // стратегии стоп сознательно выключен), не заявка на выход. Передать её сюда как
        // stopPrice значило бы заставить движок закрывать сделку по касанию этой цены —
        // ровно то сочетание («ATR-стоп поверх следящего выхода»), которое проверено и
        // оказалось хуже, чем стопа не иметь вовсе.
        stopPrice: (trade.stopLoss && !trade.stopIsSizingOnly) ? parseFloat(trade.stopLoss) : null,
        takePrice: trade.takeProfit ? parseFloat(trade.takeProfit) : null,
        mode: 'shadow',
      });
    } catch { return null; }
  }, [compareStrategy, trade, candles, state?.entryIndex]);

  if (loading) return <div className="ck-wrap"><div className="ck-loading">Загружаю открытые позиции…</div></div>;

  // Раньше здесь были две отдельные заглушки — «предпросмотр инструмента из радара» и
  // «открытых позиций нет», у каждой своя урезанная вёрстка. Реальная просьба: Сопровождение
  // выглядит ОДИНАКОВО и когда сделка есть, и когда её нет — те же верхняя панель, левая
  // колонка (позиции, бумажные, радар) и правая часть; без сделки в правой части просто
  // нет того, что относится к позиции. Поэтому теперь единая вёрстка ниже.

  const a = state?.actual;
  const s = state?.shadow;
  const base = (!showMe && s) ? s : a;
  const verdictAction = alerts.some((x) => x.severity === 'action' || x.severity === 'danger');

  return (
    <div className="ck-wrap">
      <div className="ck-top">
        <div>
          <h1 className="ck-title">Сопровождение</h1>
          <div className="ck-sub">{trade ? (isPaper ? 'Бумажная сделка изнутри' : 'Открытая позиция изнутри') : 'Выберите инструмент в радаре — откроется его график'}</div>
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
            <Icon name="refresh" size={14} style={{ marginRight: 6 }} />{computing ? 'Считаю…' : 'Обновить'}
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

      {/* Режим: общий обзор или одна стратегия. В режиме стратегии весь экран говорит только о ней. */}
      {strategies.length > 0 && (
        <nav className="ck-scope" aria-label="Режим">
          <button className={scopeId === 'all' ? 'on' : ''} onClick={() => chooseScope('all')}>
            <Icon name="dashboard" size={14} /> Обзор
          </button>
          {strategies.map((st) => (
            <button key={st.id} className={scopeId === st.id ? 'on' : ''} onClick={() => chooseScope(st.id)} title={st.name}>
              {st.name || 'Без названия'}
            </button>
          ))}
        </nav>
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
        <aside className="ck-side scroll-box">
          <CollapsibleSection title="Открытые позиции" badge={trades.length}>
            <div className="ck-pos-list">
              {trades.filter((t) => scopeId === 'all' || !t.entryStrategyId || t.entryStrategyId === scopeId).map((t) => {
                const on = t.id === activeId;
                const rem = parseFloat(t.remainingVolume ?? t.volume) || 0;
                const vol = parseFloat(t.volume) || 0;
                return (
                  <div key={t.id} className={`ck-pos ${on ? 'on' : ''}`}>
                    <button className="ck-pos-main" onClick={() => selectTrade(t.id)}>
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

          {/* Бумажные сделки — отдельной группой, а не вперемешку с настоящими. Их
              открывает и закрывает робот, поэтому кнопки «Закрыть» здесь нет: закрыть
              бумажную сделку руками означало бы вмешаться в тот самый эксперимент, ради
              которого она и заведена. */}
          <CollapsibleSection title="Бумажные сделки" badge={paperTrades.length || null} defaultOpen={false}>
            <div className="ck-basket-note">
              Их ведёт робот по списку радара: реальных денег не касаются и в Журнал,
              депозит и отчёты не попадают. У каждой стратегии своя лента — их не сравнивают
              между собой, а смотрят по отдельности.
            </div>
            {/* Вкладки по стратегиям — только когда стратегий больше одной. */}
            {paperGroups.groups.length > 1 && (
              <div className="ck-paper-tabs">
                <button className={paperFilter === 'all' ? 'on' : ''} onClick={() => setPaperFilter('all')}>
                  Все <span>{paperTrades.length}</span>
                </button>
                {paperGroups.groups.map((g) => (
                  <button key={g.key} className={paperFilter === g.key ? 'on' : ''} onClick={() => setPaperFilter(g.key)} title={g.label}>
                    {g.label} <span>{g.open}</span>
                  </button>
                ))}
              </div>
            )}
            {filterGroup && (filterGroup.closed > 0 || filterGroup.open > 0) && (
              <div className="ck-paper-sum">
                <span>открыто <b>{filterGroup.open}</b></span>
                <span>закрыто <b>{filterGroup.closed}</b></span>
                {filterGroup.closed > 0 && (
                  <>
                    <span>итог <b className={filterGroup.pnl >= 0 ? 'up' : 'down'}>{filterGroup.pnl >= 0 ? '+' : '−'}{fmtNum(Math.abs(filterGroup.pnl), 0)} ₽</b></span>
                    <span>прибыльных <b>{Math.round(filterGroup.winrate)}%</b></span>
                    {filterGroup.avgHoldDays != null && <span>держит в среднем <b>{filterGroup.avgHoldDays < 1 ? `${Math.max(1, Math.round(filterGroup.avgHoldDays * 24))} ч` : `${fmtNum(filterGroup.avgHoldDays, 1)} дн`}</b></span>}
                  </>
                )}
              </div>
            )}
            <div className="ck-pos-list">
              {visiblePaper.map((t) => {
                // Кнопка «Повторить» прямо в строке — тем же окном подтверждения, что и в панели
                // сделки. Видна только когда сервер заявок готов и тикер разрешён.
                const orderable = !!(orderCfg?.enabled && (orderCfg.wildcard || orderCfg.whitelist?.includes(String(t.ticker).toUpperCase())));
                return (
                  <div key={t.id} className={`ck-pos ${t.id === activeId ? 'on' : ''}`}>
                    <button className="ck-pos-main" onClick={() => selectTrade(t.id)}>
                      <div className="ck-pos-row">
                        <span className="ck-ticker">{t.ticker}</span>
                        <span className={`ck-dir ${t.direction}`}>
                          {t.direction === 'short' ? 'ШОРТ' : 'ЛОНГ'}
                        </span>
                      </div>
                      {/* Стратегия, которая открыла сделку, и её таймфрейм — чтобы ленты разных
                          горизонтов не путались в общем списке. */}
                      {(t.entryStrategyName || t.entryTimeframe) && (
                        <div className="ck-pos-strat">
                          {t.entryStrategyName || 'Без стратегии'}{t.entryTimeframe ? ` · ${t.entryTimeframe}` : ''}
                        </div>
                      )}
                      {/* «объём условный» — по правилам риска денег на такую позицию не
                          хватает, робот открыл её одним контрактом только ради наблюдения. */}
                      <div className="ck-pos-sub">
                        {fmtNum(parseFloat(t.volume) || 0, 0)} конт. · вход {fmtNum(t.entryPrice)}
                        {t.riskTooBig ? ' · объём условный' : ''}
                        {t.repeatedAt ? ' · повторена' : ''}
                      </div>
                    </button>
                    {orderable && !t.repeatedAt && (
                      <button
                        className="ck-pos-close"
                        title="Открыть такую же настоящую позицию (будет окно подтверждения)"
                        onClick={() => {
                          selectTrade(t.id);
                          setRepeatOrder({ lots: Math.max(1, Math.round(parseFloat(t.volume) || 1)) });
                        }}
                      >
                        Повторить
                      </button>
                    )}
                  </div>
                );
              })}
              {!visiblePaper.length && (
                <div className="ck-radar-empty">
                  {paperFilter === 'all'
                    ? 'Пока ни одной. Робот проверяет список радара каждые 15 минут в торговые часы и откроет сделку сам, когда по инструменту сойдутся условия стратегии.'
                    : 'У этой стратегии сейчас нет открытых бумажных сделок.'}
                </div>
              )}
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
                      <div className="ck-rung-2">система зафиксировала бы здесь</div>
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

          <CollapsibleSection
            title="Корзины портфеля"
            badge={baskets.baskets.length || null}
            defaultOpen={false}
          >
            <div className="ck-basket-note">
              Корзина — это учёт, а не отдельный счёт у брокера. Влияет ровно на одно: риск
              на сделку считается от денег корзины её стратегии, а не от всего депозита.
            </div>

            <div className="ck-basket-list">
              {baskets.baskets.map((b) => (
                <div className="ck-basket" key={b.strategyId}>
                  <div className="ck-basket-main">
                    <div className="ck-basket-name">{b.name}</div>
                    <div className="ck-basket-sub">
                      {formatCurrency(Math.round(b.allocated))} · {b.sharePct}%
                      {Math.abs(b.driftPct) >= 5 && (
                        <span className="ck-basket-drift">
                          {' '}(сейчас {b.driftPct > 0 ? '+' : ''}{b.driftPct.toFixed(0)} п.п.)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={`ck-basket-pnl ${b.pnl >= 0 ? 'up' : 'down'}`}>{fmtRub(b.pnl)}</div>
                  <button className="ck-radar-del" onClick={() => removeBasket(b.strategyId)} title="Убрать корзину">✕</button>
                </div>
              ))}
              {!baskets.baskets.length && (
                <div className="ck-radar-empty">
                  Портфель не разбит на корзины — риск считается от всего депозита.
                  Добавьте стратегию ниже, чтобы у неё была своя доля счёта.
                </div>
              )}
            </div>

            {/* Доли не подгоняются под 100% молча — трейдер должен видеть, что часть счёта
                не отдана ни одной стратегии (та же логика, что в карточке Капитала). */}
            {!!baskets.baskets.length && Math.abs(baskets.shareTotal - 100) > 0.01 && (
              <div className="ck-basket-warn">
                Сумма долей — {baskets.shareTotal}%.{' '}
                {baskets.shareTotal < 100
                  ? `${(100 - baskets.shareTotal).toFixed(0)}% счёта не участвуют.`
                  : 'Больше 100%: риск будет считаться от несуществующих денег.'}
              </div>
            )}

            <div className="ck-basket-add">
              <select
                className="ck-select-dark ck-basket-sel"
                value={newBasketId}
                onChange={(e) => setNewBasketId(e.target.value)}
              >
                <option value="">+ добавить стратегию…</option>
                {strategies
                  .filter((s) => !baskets.baskets.some((b) => b.strategyId === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name || 'Без названия'}</option>
                  ))}
              </select>
              {!!newBasketId && (
                <>
                  <input
                    className="ck-basket-pct"
                    type="number" min="0" max="100" step="5" placeholder="%"
                    value={newBasketPct}
                    onChange={(e) => setNewBasketPct(e.target.value)}
                  />
                  <button className="ck-btn" onClick={addBasket} disabled={savingBasket}>
                    {savingBasket ? '…' : 'Добавить'}
                  </button>
                </>
              )}
            </div>

            <div className="ck-basket-note">
              Полная таблица с результатом каждой корзины — в <Link to="/capital">Капитале</Link>.
            </div>
          </CollapsibleSection>

          <RadarPanel filterId={scopeId} onFilterChange={(v) => { if (v !== scopeId) chooseScope(v); }} onItems={setRadarItems} />
        </aside>

        {/* ---------- кабина ---------- */}
        <main className="ck-main">
          {error && <div className="ck-panel ck-error">{error}</div>}

          {/* Инструмент из радара без сделки: шапка того же вида, что у сделки, только без
              двух линий «ты / система» — им без позиции нечего показывать. */}
          {!trade && previewTicker && (
            <section className="ck-panel ck-head">
              <div className="ck-head-id">
                <span className="ck-head-ticker">{previewTicker}</span>
                {catalogEntry(previewTicker) && (
                  <span className="ck-line-sub">{catalogEntry(previewTicker).name}</span>
                )}
              </div>
              <div className="ck-line-sub">
                По инструменту сейчас нет ни твоей, ни бумажной сделки — можно посмотреть график,
                технический анализ и готовность к входу.
              </div>
            </section>
          )}

          {/* Обзор: что происходит у каждой стратегии. Показывается, пока ничего не выбрано. */}
          {!trade && !previewTicker && scopeId === 'all' && (
            <StrategyOverview strategies={strategies} groups={paperGroups.groups} radar={radarByStrategy} onPick={chooseScope} />
          )}

          {/* Инструмент не выбран вообще — та же вёрстка, но вместо графика подсказка. */}
          {!trade && !previewTicker && (
            <section className="ck-panel ck-blank">
              <h2>Выберите инструмент</h2>
              <p>
                Нажмите на любой инструмент в радаре слева — здесь откроется его график, технический
                анализ и готовность к входу. Когда появится сделка (твоя или бумажная), эта же
                вкладка покажет её изнутри: что видят профит- и лосс-системы и что сделал бы движок.
              </p>
              <p className="ck-muted">
                Открыть сделку самому: <Link to="/journal">Журнал</Link> или <Link to="/calculator">Калькулятор</Link>.
              </p>
            </section>
          )}

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
                  {/* У бумажной сделки нет трейдера: подпись «Факт · ты» врала бы, будто ты в ней торгуешь.
                      Это просто движение цены от входа — «если ничего не делать». */}
                  <span className="ck-k">{isPaper ? 'Цена от входа' : 'Факт · ты'}</span>
                  <span className={`ck-line-v ${(a?.currentPct ?? 0) >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(a?.currentPct)}
                  </span>
                  <span className="ck-line-sub">{fmtNum(trade.entryPrice)} → {fmtNum(money?.price)}</span>
                </button>
                <button
                  className={`ck-line ${showSys ? 'on' : 'off'}`}
                  onClick={() => (showSys && !showMe ? null : setShowSys(!showSys))}
                >
                  <span className="ck-k">{isPaper ? 'Система (ведёт сделку)' : 'Система'}</span>
                  {/* Итог линии, а не цена последнего бара: движок фиксировал по пути и,
                      возможно, уже вышел — по текущей цене обе линии всегда совпадали. */}
                  <span className={`ck-line-v ${(s?.resultPct ?? 0) >= 0 ? 'up' : 'down'}`}>
                    {fmtPct(s?.resultPct)}
                  </span>
                  <span className="ck-line-sub">
                    {/* "Система" — гипотетическая линия: что было бы, если бы КАЖДЫЙ её
                        сигнал исполнялся. Раньше подпись "фиксаций: N" читалась как факт
                        о трейдере, хотя это счёт самого движка (реальная жалоба: "пишет,
                        что я зафиксировал, а я ничего не делал") — явно добавляем "бы". */}
                    {s?.exit ? `закрыла бы: ${s.exit.reason}` : `зафиксировала бы: ${s?.profitCutsDone ?? 0}`}
                  </span>
                </button>
                {/* Третье окошко — другая стратегия на этой же сделке. Пока стратегия не
                    выбрана, считать нечего, поэтому здесь просто выпадающий список. */}
                {strategies.length > 1 && (
                  <div className="ck-line ck-line-cmp">
                    <select
                      className="ck-select-dark ck-line-sel"
                      value={compareId}
                      onChange={(e) => setCompareId(e.target.value)}
                      title="Посмотреть, как эту сделку вела бы другая стратегия"
                    >
                      <option value="">+ сравнить</option>
                      {strategies.filter((x) => x.id !== strategy?.id).map((x) => (
                        <option key={x.id} value={x.id}>{x.name || 'Без названия'}</option>
                      ))}
                    </select>
                    {!compareStrategy && <span className="ck-line-sub">как вела бы эту сделку</span>}
                    {compareStrategy && !compareLine && <span className="ck-line-sub">не удалось посчитать</span>}
                    {compareStrategy && compareLine && (
                      <>
                        <span className={`ck-line-v ${(compareLine.resultPct ?? 0) >= 0 ? 'up' : 'down'}`}>
                          {fmtPct(compareLine.resultPct)}
                        </span>
                        <span className="ck-line-sub">
                          {compareLine.exit
                            ? `закрыла бы: ${compareLine.exit.reason}`
                            : `зафиксировала бы: ${compareLine.profitCutsDone ?? 0}`}
                        </span>
                      </>
                    )}
                  </div>
                )}
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
                    {/* stopIsSizingOnly — эта цена не выход, а ATR-порог для расчёта
                        объёма (у стратегии стоп сознательно выключен). Подпись честно
                        об этом говорит, а не выглядит как реальный план выхода. */}
                    <span className="ck-k">{trade.stopIsSizingOnly ? 'Аварийный порог (не выход)' : 'Стоп из плана'}</span>
                    <span className="ck-v down">{fmtNum(trade.stopLoss)}</span>
                    {trade.stopIsSizingOnly && (
                      <span className="ck-line-sub">выход — только следящий</span>
                    )}
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

          {/* ---------- одинаково и со сделкой, и без неё: кнопки, тех. анализ ---------- */}
          {(trade || previewTicker) && (
            <div className="ck-verdict-actions" style={{ justifyContent: 'flex-start' }}>
              <button className={`ck-btn ${taOpen ? 'ck-btn-primary' : ''}`} onClick={() => setTaOpen((o) => !o)}>
                Технический анализ {taOpen ? '▴' : '▾'}
              </button>
              {!trade && (
                <Link
                  className="ck-btn ck-btn-primary"
                  style={{ textDecoration: 'none' }}
                  to={`/calculator?ticker=${encodeURIComponent(previewTicker)}&type=${encodeURIComponent(previewType)}`}
                >
                  Войти в сделку
                </Link>
              )}
            </div>
          )}

          {taOpen && taTicker && (
            <section className="ck-panel">
              <TechnicalAnalysisBlock
                state={taState}
                onRefresh={() => loadTa(null)}
                title="Технический анализ сейчас"
              />
            </section>
          )}

          {/* Вместо профит-/лосс-систем, которым без позиции нечего оценивать (они считают
              пик, просадку и число баров С ВХОДА), — готовность к входу по условиям стратегии:
              те же условия проверяет робот и показывает Калькулятор. */}
          {previewReady && (() => {
            const share = (r) => (r.total ? r.passed / r.total : 0);
            const auto = share(previewReady.long) >= share(previewReady.short) ? 'long' : 'short';
            const dir = previewDir || auto;
            return (
              <section className="ck-panel">
                <div className="ck-hist-top">
                  <h3>Готовность к входу</h3>
                  <div className="ck-shares">
                    <button className={`ck-share ${dir === 'long' ? 'on' : ''}`} onClick={() => setPreviewDir('long')}>Лонг</button>
                    <button className={`ck-share ${dir === 'short' ? 'on' : ''}`} onClick={() => setPreviewDir('short')}>Шорт</button>
                  </div>
                </div>
                <div className="ck-hist-note">
                  Условия входа стратегии «{strategy?.name || 'без названия'}» на текущем баре.
                  Робот открывает бумажную сделку, когда сходятся все условия (порог стратегии).
                </div>
                <StrategyChecklist
                  strategyName={strategy?.name}
                  result={previewReady[dir]}
                  readinessThreshold={strategy?.readinessThreshold}
                />
              </section>
            );
          })()}

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
                    // Счёт может уйти в минус (штраф «слишком рано» на свежей сделке весит
                    // −1 сам по себе) — это верно для сравнения с порогом, но «−1 из 4» на
                    // экране читается как поломка, а не как «рано, есть штраф». Показываем 0.
                    : `Профит-система ${Math.max(0, a?.now?.profitScore ?? 0)} из ${exitRules.profitCaptureThreshold ?? 4}`
                      + `, лосс-система ${a?.now?.lossScore == null ? '—' : Math.max(0, a.now.lossScore)} из ${exitRules.lossScoreThreshold ?? 2}.`}
                </div>
              </div>
              {(() => {
                // У бумажной сделки фиксировать нечего — в рынке позиции нет. Вместо
                // кнопок закрытия предлагается ПОВТОРИТЬ её своей заявкой, то есть
                // открыть позицию, а не закрыть.
                if (isPaper) {
                  return (
                    <div className="ck-verdict-actions" style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
                      {canOrderRepeat && (
                        <button className="ck-btn ck-btn-primary" onClick={openRepeatOrder}>
                          Повторить реальной заявкой
                        </button>
                      )}
                      {trade.repeatedAt && (
                        <div className="ck-order-hint">
                          Эту сделку ты уже повторял — проверь Журнал, чтобы не войти второй раз.
                        </div>
                      )}
                      {trade.riskTooBig && (
                        <div className="ck-order-hint">
                          Объём у бумажной условный: по твоим правилам риска на эту позицию
                          не хватает денег. Настоящая заявка уйдёт на тот же объём — решай сам.
                        </div>
                      )}
                      {repeatUnavailableReason && <div className="ck-order-hint">{repeatUnavailableReason}</div>}
                    </div>
                  );
                }
                const suggestedQty = alerts[0]?.suggestedShare && money
                  ? money.remainingVol * (alerts[0].suggestedShare / 100) : money?.remainingVol;
                return canOrderClose ? (
                  <div className="ck-verdict-actions">
                    <button className="ck-btn ck-btn-primary" onClick={() => openCloseOrder(suggestedQty)}>
                      Зафиксировать сейчас
                    </button>
                    <button className="ck-btn" onClick={() => goToClose(trade, suggestedQty)} title="Записать в Журнал вручную, без заявки брокеру">
                      Записать вручную
                    </button>
                  </div>
                ) : (
                  <div className="ck-verdict-actions" style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
                    <button className="ck-btn ck-btn-primary" onClick={() => goToClose(trade, suggestedQty)}>
                      Зафиксировать в Журнале
                    </button>
                    {orderUnavailableReason && <div className="ck-order-hint">{orderUnavailableReason}</div>}
                  </div>
                );
              })()}
            </section>
          )}

          {/* ---------- график ---------- */}
          {(trade || previewTicker) && (
          <section className="ck-panel ck-chart">
            {(trade ? candles : taState.data?.candles)?.length ? (
              <CandleChart
                candles={trade ? candles : taState.data.candles}
                patterns={trade ? patterns : taState.data.patterns}
                height={390}
                ticker={trade ? trade.ticker : previewTicker}
                timeframe={trade ? timeframe : (taTf || userProfile?.preferredTimeframe || 'D1')}
                timeframeOptions={tfOptions}
                onTimeframeChange={trade ? setTfOverride : (tf) => { setTaTf(tf); loadTa(tf); }}
                legs={trade?.legs}
                systemMarkers={systemMarkers}
                direction={trade?.direction}
                entryPrice={trade?.entryPrice ? parseFloat(trade.entryPrice) : null}
                planLines={{
                  entry: trade?.entryPrice ? parseFloat(trade.entryPrice) : null,
                  stop: trade?.stopLoss ? parseFloat(trade.stopLoss) : null,
                  take: trade?.takeProfit ? parseFloat(trade.takeProfit) : null,
                }}
              />
            ) : (
              <div className="ck-loading">
                {trade
                  ? (computing ? 'Загружаю график…' : 'Нет данных')
                  : (taState.loading ? 'Загружаю график…' : (taState.error || 'Нет данных'))}
              </div>
            )}
          </section>
          )}

          {/* ---------- если закрыть сейчас ---------- */}
          {money && (
            <section className="ck-panel ck-calc">
              <h3>{isPaper ? 'Если бы закрыл сейчас' : 'Если закрыть сейчас'}</h3>
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
                <div><span className="ck-k">{isPaper ? 'Считаем' : 'Закрываем'}</span><b>{fmtNum(money.closingVol, 0)} конт. по {fmtNum(money.price)}</b></div>
                <div><span className="ck-k">Грязными</span><b>{fmtRub(money.gross)}</b></div>
                <div><span className="ck-k">Комиссия</span><b className="down">{fmtRub(-money.commission)}</b></div>
                <div><span className="ck-k">Уже зафиксировано</span><b>{fmtRub(money.realized)}</b></div>
                <div><span className="ck-k">Итого по сделке</span>
                  <b className={money.net >= 0 ? 'up' : 'down'}>{fmtRub(money.net)}</b></div>
              </div>
              <div className="ck-calc-foot">
                <div className="ck-note">
                  Цифры считаются теми же полями сделки, что и в Журнале — шаг цены, стоимость шага, комиссия.
                  {canOrderClose && ' Оценка выше — по последней цене графика; в заявке сервер покажет реальную.'}
                </div>
                {orderUnavailableReason && <div className="ck-order-hint">{orderUnavailableReason}</div>}
                {isPaper ? (
                  <div className="ck-order-hint" style={{ textAlign: 'left', maxWidth: 'none' }}>
                    Закрывать нечего: позиции в рынке нет, это расчёт «чем бы она шла, если
                    бы ты в неё вошёл». Саму бумажную сделку ведёт и закроет робот.
                  </div>
                ) : canOrderClose ? (
                  <div className="ck-verdict-actions">
                    <button className="ck-btn ck-btn-primary" onClick={() => openCloseOrder(money.closingVol)}>
                      Зафиксировать {closeShare}% сейчас
                    </button>
                    <button className="ck-btn" onClick={() => goToClose(trade, money.closingVol)} title="Записать в Журнал вручную, без заявки брокеру">
                      Записать вручную
                    </button>
                  </div>
                ) : (
                  <button className="ck-btn ck-btn-primary" onClick={() => goToClose(trade, money.closingVol)}>
                    Зафиксировать {closeShare}% в Журнале
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Заявка на закрытие — тот же OrderModal, что и «Купить сразу», развёрнутый
              в обратную сторону (продажа для лонга, покупка для шорта). closeOrder
              задаётся кнопками выше; закрывается сбросом в null. */}
          <OrderModal
            open={!!closeOrder}
            onClose={() => setCloseOrder(null)}
            userProfile={userProfile}
            accounts={orderCfg?.accounts}
            title={trade?.direction === 'short' ? 'Купить (закрыть шорт) через Т-Банк' : 'Продать (зафиксировать) через Т-Банк'}
            autoRecordsToJournal
            intent={trade && closeOrder ? {
              ticker: trade.ticker.toUpperCase(),
              instrumentType: trade.instrumentType || 'stock',
              direction: trade.direction === 'short' ? 'buy' : 'sell',
              lots: closeOrder.lots,
              price: money?.price ?? null,
            } : null}
            onPlaced={handleCloseOrderPlaced}
          />

          {/* Повтор бумажной сделки — то же окно подтверждения, но направление
              ОТКРЫВАЮЩЕЕ: покупка для лонга, продажа для шорта (у заявки на закрытие выше
              всё наоборот). Цена подставляется ТЕКУЩАЯ с графика, а не та, по которой
              вошла бумажная сделка: та могла быть вчера, и лимитная заявка по ней просто
              повисла бы, ничего не исполнив. */}
          <OrderModal
            open={!!repeatOrder}
            onClose={() => setRepeatOrder(null)}
            userProfile={userProfile}
            accounts={orderCfg?.accounts}
            title={trade?.direction === 'short' ? 'Продать (открыть шорт) через Т-Банк' : 'Купить через Т-Банк'}
            autoRecordsToJournal
            intent={trade && repeatOrder ? {
              ticker: trade.ticker.toUpperCase(),
              instrumentType: trade.instrumentType || 'stock',
              direction: trade.direction === 'short' ? 'sell' : 'buy',
              lots: repeatOrder.lots,
              price: money?.price ?? null,
            } : null}
            onPlaced={handleRepeatOrderPlaced}
          />

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
          {trade && (
            <>
              <div className={usesProfitSystem && usesLossSystem ? 'ck-two' : 'ck-one'}>
                {usesProfitSystem && (
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
                )}
                {usesLossSystem && (
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
                )}
              </div>
              {(!usesProfitSystem || !usesLossSystem) && (
                <div className="ck-systems-note">
                  {!usesProfitSystem && !usesLossSystem
                    ? 'Профит- и лосс-система в этой стратегии не включены: сделка ведётся обычными правилами выхода.'
                    : !usesProfitSystem
                      ? 'Профит-система в этой стратегии не включена (фиксация прибыли частями).'
                      : 'Лосс-система в этой стратегии не включена: убытки закрываются обычным стопом.'}
                  {' '}<Link to="/capital">Настроить правила выхода</Link>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
