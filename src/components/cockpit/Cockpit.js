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
import { getOpenPaperTrades, updatePaperTrade } from '../../services/paperTrades';
import { fetchDailyCandles, availableTimeframes } from '../../services/marketData/candles';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { catalogEntry } from '../../services/marketData/instrumentCatalog';
import TechnicalAnalysisBlock from '../shared/TechnicalAnalysisBlock';
import { getActiveStrategy, getStrategies } from '../../services/analytics/strategy';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';
import { commissionRateFor, DEFAULT_TARIFF } from '../../services/analytics/commission';
import { computeBaskets, getPortfolio } from '../../services/analytics/portfolio';
import { formatCurrency } from '../../utils/calculator';
import { computeBothLines, computeLiveState } from '../../services/backtest/livePosition';
import { computeProfitBreakdown, computeLossBreakdown } from '../../services/backtest/engine';
import { evaluateAlerts, DEFAULT_ALERT_PREFS } from '../../services/alerts';
import { loadBacktestSample, findSimilar, probabilityOfGoal } from '../../services/backtest/similarTrades';
import { applyTradeClose } from '../../services/tradeClose';
import { fetchOrderConfig } from '../../services/broker';
import CandleChart from '../shared/CandleChart';
import RadarPanel from './RadarPanel';
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
  // Переход из Радара может указывать конкретную сделку (обычно бумажную, которую уже
  // ведёт система) — ?activeId=... в ссылке. Читается один раз при заходе на вкладку;
  // эффекты ниже, загружающие настоящие/бумажные сделки, не перезатирают уже заданный
  // activeId (там стоит `cur || ...`), так что порядок загрузки не важен.
  const [searchParams] = useSearchParams();
  const [activeId, setActiveId] = useState(() => searchParams.get('activeId') || null);
  // Клик по инструменту в радаре, у которого система ЕЩЁ ничего не открыла (нет условий
  // или бумажная сделка ещё не завелась) — раньше вёл прямиком в Калькулятор, реальная
  // просьба трейдера: показывать график и технический анализ прямо здесь, в привычном
  // оформлении Сопровождения, а в Калькулятор вести только по явному нажатию, если решил
  // сам открыть сделку. ?previewTicker=... задаёт это ровно так же, как ?activeId=... —
  // читается один раз при заходе.
  const previewTicker = searchParams.get('previewTicker');
  const previewType = searchParams.get('previewType') || 'stock';
  const [previewTf, setPreviewTf] = useState(null);
  const [previewState, setPreviewState] = useState({ loading: false, data: null, error: null });
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

  // Тот же расчёт, что и «Технический анализ сейчас» в радаре Журнала (та же тройка
  // функций) — намеренно не общий хук с тем местом, чтобы не тащить сюда состояние
  // экрана Журнала, но результат должен читаться одинаково, поэтому логика скопирована
  // буквально, а не переизобретена.
  const loadPreview = useCallback(async (tfArg) => {
    if (!previewTicker) return;
    const tf = tfArg || previewTf || userProfile?.preferredTimeframe || 'D1';
    setPreviewState({ loading: true, data: null, error: null });
    try {
      const now = new Date();
      const cs = await fetchDailyCandles({
        ticker: previewTicker, instrumentType: previewType, toDate: now,
        tinkoffToken: userProfile?.tinkoffToken, timeframe: tf,
      });
      const indicators = computeIndicatorsAtEntry(cs, now);
      const patterns2 = computePatternsAtEntry(cs, now);
      const marketContext = computeMarketContextAtEntry(cs, now);
      if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
      setPreviewState({ loading: false, data: { indicators, patterns: patterns2, marketContext, candles: cs }, error: null });
    } catch (e) {
      setPreviewState({ loading: false, data: null, error: e.message || 'Не удалось загрузить данные' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTicker, previewType, previewTf, userProfile]);

  useEffect(() => { if (previewTicker) loadPreview(); }, [previewTicker]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- открытые позиции ---
  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      try {
        const all = await getUserTrades(user.uid);
        const open = all.filter((t) => t.status === 'open' || t.status === 'partial');
        setTrades(open);
        setAllTrades(all);
        setActiveId((cur) => cur || open[0]?.id || null);
      } catch (e) {
        toast.error('Не удалось загрузить сделки');
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  // Грузятся отдельно от настоящих: если чтение упадёт (например, коллекции в базе ещё
  // нет), вкладка должна продолжить вести реальные позиции, а не остаться пустой.
  useEffect(() => {
    if (!user) { setPaperTrades([]); return; }
    getOpenPaperTrades(user.uid).then(setPaperTrades).catch(() => setPaperTrades([]));
  }, [user]);

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
    if (!(lotsExecuted > 0) || executedPrice == null || !trade) return;
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
    if (!(lotsExecuted > 0) || executedPrice == null || !trade) return;
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

  // Предпросмотр инструмента из радара — раньше клик по тикеру, которым система ещё не
  // торгует (условия не сошлись или бумажная сделка ещё не завелась), сразу вёл в
  // Калькулятор. Реальная просьба: показывать график и технический анализ прямо здесь, в
  // привычном оформлении, а в Калькулятор вести только по явному нажатию «Открыть в
  // Калькуляторе» — если трейдер решил сам считать вход. Проверяется раньше остальных
  // веток, чтобы работать независимо от того, есть ли у трейдера другие открытые сделки.
  if (previewTicker && !trade) {
    const known = catalogEntry(previewTicker);
    return (
      <div className="ck-wrap">
        <div className="ck-layout">
          <aside className="ck-side">
            <RadarPanel />
          </aside>
          <div className="ck-main">
            <section className="ck-panel">
              <div className="ck-head">
                <div className="ck-head-id">
                  <span className="ck-head-ticker">{previewTicker}</span>
                  {known && <span style={{ color: 'var(--text-muted)' }}>{known.name}</span>}
                </div>
                <Link
                  className="btn btn-primary btn-sm"
                  to={`/calculator?ticker=${encodeURIComponent(previewTicker)}&type=${encodeURIComponent(previewType)}`}
                >
                  Открыть в Калькуляторе
                </Link>
              </div>
              <div className="ck-sub" style={{ marginTop: 4 }}>
                Систему пока не торгует этот инструмент — условия стратегии ещё не сошлись,
                или бумажная сделка ещё не завелась. Здесь можно посмотреть график и технический
                анализ, ничего не открывая.
              </div>
            </section>

            {previewState.data?.candles?.length > 0 && (
              <section className="ck-panel ck-chart">
                <CandleChart
                  candles={previewState.data.candles}
                  patterns={previewState.data.patterns}
                  height={390}
                  ticker={previewTicker}
                  timeframe={previewTf || userProfile?.preferredTimeframe || 'D1'}
                  timeframeOptions={availableTimeframes(!!userProfile?.tinkoffToken)}
                  onTimeframeChange={(tf) => { setPreviewTf(tf); loadPreview(tf); }}
                />
              </section>
            )}

            <section className="ck-panel">
              <TechnicalAnalysisBlock
                state={previewState}
                onRefresh={() => loadPreview()}
                title="Технический анализ сейчас"
              />
            </section>
          </div>
        </div>
      </div>
    );
  }

  // Раньше вкладка целиком блокировалась, если нет НАСТОЯЩИХ сделок — даже радар и список
  // бумажных (которые робот мог открыть сам) были недоступны. Реальная жалоба: «хочу
  // просто посмотреть графики, полистать радар, посмотреть что там в системах думает —
  // а тут я даже что торгует система посмотреть не могу». Пусто по-настоящему, только
  // если нет ни настоящих, ни бумажных сделок вообще — тогда показываем заглушку, но
  // РЯДОМ с радаром, а не вместо всей вкладки.
  if (!trades.length && !paperTrades.length) {
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
            Радар и список наблюдения — ниже, они работают и без открытой позиции.
          </p>
        </div>
        <RadarPanel />
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

          {/* Бумажные сделки — отдельной группой, а не вперемешку с настоящими. Их
              открывает и закрывает робот, поэтому кнопки «Закрыть» здесь нет: закрыть
              бумажную сделку руками означало бы вмешаться в тот самый эксперимент, ради
              которого она и заведена. */}
          <CollapsibleSection title="Бумажные сделки" badge={paperTrades.length || null} defaultOpen={false}>
            <div className="ck-basket-note">
              Их ведёт робот по списку радара: реальных денег не касаются и в Журнал,
              депозит и отчёты не попадают. Нужны, чтобы увидеть, как стратегия торгует
              сама, без твоего вмешательства.
            </div>
            <div className="ck-pos-list">
              {paperTrades.map((t) => (
                <div key={t.id} className={`ck-pos ${t.id === activeId ? 'on' : ''}`}>
                  <button className="ck-pos-main" onClick={() => setActiveId(t.id)}>
                    <div className="ck-pos-row">
                      <span className="ck-ticker">{t.ticker}</span>
                      <span className={`ck-dir ${t.direction}`}>
                        {t.direction === 'short' ? 'ШОРТ' : 'ЛОНГ'}
                      </span>
                    </div>
                    {/* «объём условный» — по правилам риска денег на такую позицию не
                        хватает, робот открыл её одним контрактом только ради наблюдения.
                        Помечено неброско, как и просил трейдер: это не ошибка, просто
                        результат такой сделки нельзя считать достижимым. */}
                    <div className="ck-pos-sub">
                      {fmtNum(parseFloat(t.volume) || 0, 0)} конт. · бумажная
                      {t.riskTooBig ? ' · объём условный' : ''}
                      {t.repeatedAt ? ' · повторена' : ''}
                    </div>
                    <div className="ck-pos-sub">вход {fmtNum(t.entryPrice)}</div>
                  </button>
                </div>
              ))}
              {!paperTrades.length && (
                <div className="ck-radar-empty">
                  Пока ни одной. Робот проверяет список радара каждые 15 минут в торговые
                  часы и откроет сделку сам, когда по инструменту сойдутся условия стратегии.
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
                          ⚡ Повторить реальной заявкой
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
                      ⚡ Зафиксировать сейчас
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
          <section className="ck-panel ck-chart">
            {candles?.length ? (
              <CandleChart
                candles={candles}
                patterns={patterns}
                height={390}
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
                      ⚡ Зафиксировать {closeShare}% сейчас
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
