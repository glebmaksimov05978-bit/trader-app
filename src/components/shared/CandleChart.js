// src/components/shared/CandleChart.js
//
// Candle chart with S/R/EMA/Bollinger/Fibonacci/RSI/MACD/volume overlays plus trade
// markers and a P&L zone, built on Lightweight Charts (TradingView, Apache-2.0, no
// watermark requirement outside the paid widget). Shared by Calculator (live pre-trade),
// Journal (frozen "as of entry" view with fill markers), and Radar. Data always comes
// from the same `fetchDailyCandles` used for indicators — this component doesn't know or
// care whether it's MOEX or Tinkoff behind it.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, AreaSeries, HistogramSeries, BaselineSeries, createSeriesMarkers } from 'lightweight-charts';
import { ema, bollingerSeries, rsi, macd } from '../../services/analytics/indicators';
import { TIMEFRAMES } from '../../services/marketData/candles';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import {
  drawingsFor, withDrawings, newDrawing, addDrawing, removeDrawing, rulerStats, rulerText, snapPrice, atrOf,
  TWO_POINT, PALETTE, TOOL_LABELS, moveDrawing, movePoint,
} from '../../services/chartDrawings';
import { DrawingsPrimitive } from './chartDrawingsPrimitive';
import ChartDrawingToolbar from './ChartDrawingToolbar';
import './CandleChart.css';

// `tradeOnly` chips only make sense on a real trade (Journal) — hidden in Calculator/
// Radar, where there's no entry/exit to draw. `colorable` chips get a color swatch.
const LAYER_DEFS = [
  { key: 'sr', label: 'Уровни S/R', defaultOn: true },
  { key: 'ema9', label: 'EMA9', defaultOn: false, colorable: true },
  { key: 'ema13', label: 'EMA13', defaultOn: false, colorable: true },
  { key: 'ema21', label: 'EMA21', defaultOn: false, colorable: true },
  { key: 'ema100', label: 'EMA100', defaultOn: false, colorable: true },
  { key: 'ema200', label: 'EMA200', defaultOn: false, colorable: true },
  { key: 'bollinger', label: 'Боллинджер', defaultOn: false, colorable: true },
  { key: 'fibonacci', label: 'Фибоначчи', defaultOn: false },
  { key: 'rsi', label: 'RSI', defaultOn: false },
  { key: 'macd', label: 'MACD', defaultOn: false },
  { key: 'volume', label: 'Объём', defaultOn: false },
  { key: 'pnl', label: 'Вход/выход', defaultOn: true, tradeOnly: true },
  { key: 'rightValues', label: 'Цифры справа', defaultOn: false },
  // Overview-only (backtest's all-trades-at-once chart): with hundreds of trades, a text
  // label under every single arrow/circle (Покупка/Продажа/+X.X%) overlaps into an
  // unreadable smear (real user report — "глаза мозолит, ничего толком не видно"). Off
  // by default so the overview is just clean arrows/circles; flip on to read exact %/side
  // when zoomed into a small stretch.
  { key: 'tradeLabels', label: 'Подписи на сделках (Покупка/%)', defaultOn: false, overviewOnly: true },
];

const DEFAULT_COLORS_KEY = 'traderpro-chart-colors';
const DEFAULT_COLOR_FALLBACKS = {
  ema9: '#3b82f6', ema13: '#eab308', ema21: '#a78bfa', ema100: '#f59e0b', ema200: '#ef4444', bollinger: '#9ca3af',
};

function loadSavedColors() {
  try {
    const raw = localStorage.getItem(DEFAULT_COLORS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function themeColor(varName, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function withAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Candle `date` is a JS Date; Lightweight Charts wants unix seconds for intraday series
// (using `time` as a number puts it in UTC-timestamp mode, so intraday bars that share a
// calendar day don't collapse onto one x-position).
function toChartTime(date) {
  return Math.floor(date.getTime() / 1000);
}

// Trade legs come from Firestore, where a JS Date round-trips as a Timestamp object
// ({seconds, nanoseconds}), not a Date/ISO string — `new Date(firestoreTimestamp)`
// silently yields Invalid Date (NaN). Same coercion Journal.js uses for its leg table.
function toDate(d) {
  if (d instanceof Date) return d;
  if (d?.seconds != null) return new Date(d.seconds * 1000);
  return new Date(d);
}

function fmtDateTime(seconds) {
  const d = new Date(seconds * 1000);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
    ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtVolume(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

// Snaps a leg's timestamp to the candle bar that contains it (largest candle time ≤ leg
// time). Legs and candle markers must share exact x-positions or Lightweight Charts drops
// the marker; snapping also lets several fills in one bar collapse onto a single marker.
function barTimeForLeg(legTime, candleTimes) {
  let lo = 0, hi = candleTimes.length - 1, ans = candleTimes[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTimes[mid] <= legTime) { ans = candleTimes[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// Same snap-to-bar search as barTimeForLeg, but returns the INDEX into candleTimes rather
// than the time value itself — what setVisibleLogicalRange needs to center the viewport
// on a specific trade instead of always showing the tail of the array.
function barIndexForTime(targetTime, candleTimes) {
  let lo = 0, hi = candleTimes.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTimes[mid] <= targetTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// One marker per candle bar instead of one per fill — a position built/unwound over
// several orders on the same bar used to stack labels vertically into an unreadable
// column (real user report/screenshot on M15). Fills on the same bar collapse to a
// single marker with a "×N" count; the full per-fill breakdown is returned separately
// (`fillsByBar`) for the hover tooltip.
function buildMarkersAndFills(legs, direction, candleTimes, colors) {
  if (!legs?.length) return { markers: [], fillsByBar: new Map() };

  const sorted = [...legs]
    .map((l) => ({ ...l, t: toChartTime(toDate(l.timestampUtc)) }))
    .sort((a, b) => a.t - b.t);

  const totalOpened = sorted.filter((l) => l.type === 'open').reduce((s, l) => s + l.quantity, 0);
  // Identify the leg that closes the position (cumulative closed ≥ total opened) — that's
  // the "final exit"; earlier closes are partial exits.
  let closedSoFar = 0;
  let finalCloseIdx = -1;
  sorted.forEach((l, i) => {
    if (l.type === 'close') {
      closedSoFar += l.quantity;
      if (finalCloseIdx === -1 && closedSoFar >= totalOpened) finalCloseIdx = i;
    }
  });
  const firstOpenIdx = sorted.findIndex((l) => l.type === 'open');

  // Group by bar time.
  const groups = new Map();
  const fillsByBar = new Map();
  sorted.forEach((l, i) => {
    const bar = barTimeForLeg(l.t, candleTimes);
    if (!groups.has(bar)) groups.set(bar, []);
    groups.get(bar).push({ ...l, idx: i });
    if (!fillsByBar.has(bar)) fillsByBar.set(bar, []);
    fillsByBar.get(bar).push({
      t: l.t,
      action: l.type === 'open' ? (i === firstOpenIdx ? 'Вход' : 'Докупка') : (i === finalCloseIdx ? 'Выход' : 'Частичный выход'),
      quantity: l.quantity,
      price: l.price,
    });
  });

  const markers = [];
  groups.forEach((group, bar) => {
    const opens = group.filter((l) => l.type === 'open');
    const closes = group.filter((l) => l.type === 'close');
    const hasFirstOpen = group.some((l) => l.idx === firstOpenIdx);
    const hasFinalClose = group.some((l) => l.idx === finalCloseIdx);
    const countSuffix = group.length > 1 ? ` ×${group.length}` : '';

    let base, isOpen, isFinal;
    if (opens.length && !closes.length) { base = hasFirstOpen ? 'Вход' : 'Докупка'; isOpen = true; }
    else if (closes.length && !opens.length) { base = hasFinalClose ? 'Выход' : 'Частичный выход'; isOpen = false; isFinal = hasFinalClose; }
    else { base = 'Операции'; isOpen = false; } // both opens and closes on one bar

    if (isOpen) {
      markers.push({
        time: bar,
        position: direction === 'short' ? 'aboveBar' : 'belowBar',
        color: direction === 'short' ? colors.red : colors.green,
        shape: direction === 'short' ? 'arrowDown' : 'arrowUp',
        text: base + countSuffix,
      });
    } else {
      markers.push({
        time: bar,
        position: 'aboveBar',
        color: isFinal ? colors.gold : colors.blue,
        shape: 'circle',
        text: base + countSuffix,
      });
    }
  });

  markers.sort((a, b) => a.time - b.time);
  return { markers, fillsByBar };
}

// All of a backtest's trades on one chart at once — different from buildMarkersAndFills
// above, which groups the FILLS of a single real trade. Here each backtest trade is
// already a clean single entry + single exit (the engine doesn't model partial fills),
// so it's just two markers per trade: an arrow for the entry (up=long/down=short, like
// "Покупка"/"Продажа" on a terminal) and a circle for the exit, colored by whether that
// trade won or lost — the trader wants to eyeball "does a green circle actually land
// where the chart looks like it should have worked out".
function buildTradesMarkers(trades, colors, showLabels) {
  if (!trades?.length) return [];
  const markers = [];
  trades.forEach((t) => {
    markers.push({
      time: toChartTime(toDate(t.entryDate)),
      position: t.direction === 'short' ? 'aboveBar' : 'belowBar',
      color: t.direction === 'short' ? colors.red : colors.green,
      shape: t.direction === 'short' ? 'arrowDown' : 'arrowUp',
      text: showLabels ? (t.direction === 'short' ? 'Продажа' : 'Покупка') : '',
    });
    if (t.status === 'closed' && t.exitDate) {
      const win = t.pnlPct >= 0;
      markers.push({
        time: toChartTime(toDate(t.exitDate)),
        position: 'aboveBar',
        color: win ? colors.green : colors.red,
        shape: 'circle',
        text: showLabels ? (win ? `+${t.pnlPct.toFixed(1)}%` : `${t.pnlPct.toFixed(1)}%`) : '',
      });
    }
  });
  markers.sort((a, b) => a.time - b.time);
  return markers;
}

// Small circular color swatch + native color input — the trader picks each EMA/Bollinger
// color themselves.
function ColorPicker({ color, onChange }) {
  return (
    <label style={{
      display:'inline-flex', width:14, height:14, borderRadius:'50%', background:color,
      border:'1px solid var(--border-subtle)', cursor:'pointer', flexShrink:0, position:'relative',
    }} title="Выбрать цвет">
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        style={{position:'absolute', inset:0, opacity:0, cursor:'pointer', width:'100%', height:'100%'}}
      />
    </label>
  );
}

export default function CandleChart({
  candles,
  patterns,
  ticker,
  timeframe,
  timeframeOptions,
  onTimeframeChange,
  entryMarker, // { date, price, direction } — fallback when `legs` isn't available
  exitMarker,  // { date, price } — fallback when `legs` isn't available
  legs,        // trade.legs: [{ type: 'open'|'close', side, quantity, price, timestampUtc }, ...]
  direction,   // 'long' | 'short'
  entryPrice,  // avg entry price — draws the entry line + P&L zone (Journal only)
  exitPrice,   // avg exit price — closes the P&L zone (null while the trade is open)
  planLines,   // { entry, stop, take } — Calculator plan
  trades,      // Бэктест: [{ direction, entryDate, exitDate, status, pnlPct }, ...] — ALL trades on one chart, overrides legs/entryMarker/exitMarker
  systemMarkers, // [{ date, text }] — где система (движок) закрыла бы позицию; только у открытых сделок в Сопровождении
  layerPreset, // ['sr','rsi',…] | null — «призма» стратегии: ровно эти индикаторные слои включены; null — как выбрал трейдер
  drawRequest = null, // { key, list } — нарисовать готовые рисунки (например, найденную фигуру) и открыть панель
  drawingTools = false, // true — панель «Рисование» и сохранение рисунков по паре «тикер + таймфрейм» в профиле
  height,      // px, необязательный — переопределяет высоту графика вне полноэкранного режима (по умолчанию 300 + панели RSI/MACD)
}) {
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const fillsByBarRef = useRef(new Map());
  const isTrade = entryPrice != null;
  const slotRef = useRef(null);
  const hostRef = useRef(null);
  if (!hostRef.current && typeof document !== 'undefined') hostRef.current = document.createElement('div');
  const hostEl = hostRef.current;
  useEffect(() => () => { hostEl?.parentNode?.removeChild(hostEl); }, [hostEl]);

  // ---- рисование ----
  const { userProfile, updateUserProfile } = useAuth();
  const primRef = useRef(null);
  const [drawings, setDrawings] = useState(() => (drawingTools ? drawingsFor(userProfile, ticker, timeframe) : []));
  const [drawOpen, setDrawOpen] = useState(false);
  const [tool, setTool] = useState('cursor');
  const [drawColor, setDrawColor] = useState(PALETTE[0]);
  const [magnet, setMagnet] = useState(true);
  const [textLabel, setTextLabel] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [draftPoint, setDraftPoint] = useState(null); // первая точка двухточечного инструмента
  const [rulerDone, setRulerDone] = useState(null);   // готовая линейка (до следующего клика)
  // Подписка на клик создаётся один раз — актуальное состояние читает через ref (см. ниже).
  const drawRef = useRef({});

  // Рисунки привязаны к паре «инструмент + таймфрейм»: при смене графика подгружаем свои.
  useEffect(() => {
    if (!drawingTools) return;
    setDrawings(drawingsFor(userProfile, ticker, timeframe));
    setSelectedId(null); setDraftPoint(null); setRulerDone(null);
    // userProfile намеренно не в зависимостях: локальная копия — источник правды после загрузки,
    // иначе каждый сохранённый рисунок перезапускал бы загрузку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingTools, ticker, timeframe]);

  const persistDrawings = async (list) => {
    const next = withDrawings(userProfile, ticker, timeframe, list);
    if (!next) { toast.error('Слишком много графиков с рисунками — сотрите ненужные'); return; }
    try {
      await updateUserProfile({ chartDrawings: next });
    } catch (e) {
      toast.error('Рисунок не сохранился: ' + (e.message || 'ошибка'));
    }
  };
  const commitDrawings = (list) => { setDrawings(list); persistDrawings(list); };
  drawRef.current = {
    tool, color: drawColor, magnet, label: textLabel, draft: draftPoint, drawings, selectedId, ticker, timeframe,
    commit: commitDrawings, setDraw: setDrawings,
  };

  const [layers, setLayers] = useState(() =>
    Object.fromEntries(LAYER_DEFS.map((l) => [l.key, l.defaultOn]))
  );
  const [colors, setColors] = useState(() => ({ ...DEFAULT_COLOR_FALLBACKS, ...loadSavedColors() }));
  const [fullscreen, setFullscreen] = useState(false);
  useLayoutEffect(() => {
    const target = fullscreen ? document.body : slotRef.current;
    if (target && hostEl && hostEl.parentNode !== target) target.appendChild(hostEl);
    const t = setTimeout(() => {
      if (chartRef.current && containerRef.current) chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    }, 30);
    return () => clearTimeout(t);
  }, [fullscreen, hostEl]);
  // На телефоне ряд бейджей индикаторов сворачивается в кнопку (см. CandleChart.css) —
  // это её состояние. На широком экране CSS-медиазапрос саму кнопку прячет, а ряд
  // всегда открыт, так что состояние там ни на что не влияет.
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);

  // Призма стратегии: пока задан layerPreset, индикаторные слои равны ему; при возврате к null —
  // слои возвращаются к значениям по умолчанию. Слои сделки («Вход/выход», цифры справа) не трогаем.
  const presetKey = Array.isArray(layerPreset) ? [...layerPreset].sort().join(',') : null;
  const prevPresetKey = useRef(null);
  useEffect(() => {
    if (presetKey === prevPresetKey.current) return;
    const wasActive = prevPresetKey.current !== null;
    prevPresetKey.current = presetKey;
    if (presetKey === null && !wasActive) return;
    const indicatorKeys = ['sr', 'ema9', 'ema13', 'ema21', 'ema100', 'ema200', 'bollinger', 'fibonacci', 'rsi', 'macd', 'volume'];
    const set = new Set(presetKey ? presetKey.split(',').filter(Boolean) : []);
    setLayers((cur) => {
      const next = { ...cur };
      for (const k of indicatorKeys) {
        next[k] = presetKey === null ? LAYER_DEFS.find((l) => l.key === k)?.defaultOn === true : set.has(k);
      }
      return next;
    });
  }, [presetKey]);

  const toggleLayer = (key) => setLayers((s) => ({ ...s, [key]: !s[key] }));
  const setColor = (key, value) => setColors((s) => {
    const next = { ...s, [key]: value };
    try { localStorage.setItem(DEFAULT_COLORS_KEY, JSON.stringify(next)); } catch {}
    return next;
  });

  // Chart instance + crosshair tooltip created once per mount.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: themeColor('--text-secondary', '#9ca3af'),
      },
      grid: {
        vertLines: { color: themeColor('--border-subtle', 'rgba(255,255,255,0.06)') },
        horzLines: { color: themeColor('--border-subtle', 'rgba(255,255,255,0.06)') },
      },
      rightPriceScale: { borderColor: themeColor('--border-subtle', 'rgba(255,255,255,0.06)') },
      timeScale: {
        borderColor: themeColor('--border-subtle', 'rgba(255,255,255,0.06)'),
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });
    chartRef.current = chart;
    seriesRef.current.candles = chart.addSeries(CandlestickSeries, {
      upColor: themeColor('--green', '#10b981'),
      downColor: themeColor('--red', '#ef4444'),
      borderVisible: false,
      wickUpColor: themeColor('--green', '#10b981'),
      wickDownColor: themeColor('--red', '#ef4444'),
    });

    // Floating tooltip: on hover, show the bar's date + O/H/L/C, and if any trade fills
    // landed on that bar, list each one (time/action/qty/price) — this is the "hover to
    // see the history" behind the collapsed ×N markers.
    const onMove = (param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const candle = param.seriesData?.get(seriesRef.current.candles);
      if (!param.time || !param.point || !candle) { tip.style.display = 'none'; return; }
      const f = (n) => n?.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
      let html = `<div style="font-weight:600;margin-bottom:2px">${fmtDateTime(param.time)}</div>`;
      html += `<div>О ${f(candle.open)} · В ${f(candle.high)} · Н ${f(candle.low)} · З ${f(candle.close)}</div>`;
      const fills = fillsByBarRef.current.get(param.time);
      if (fills?.length) {
        html += '<div style="margin-top:4px;border-top:1px solid var(--border-subtle);padding-top:4px">';
        fills.forEach((fl) => {
          html += `<div>${fl.action}: ${fl.quantity} по ${f(fl.price)}</div>`;
        });
        html += '</div>';
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const box = containerRef.current.getBoundingClientRect();
      let left = param.point.x + 14;
      if (left + 190 > box.width) left = param.point.x - 190;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, param.point.y + 12) + 'px';
    };
    chart.subscribeCrosshairMove(onMove);

    // ---- рисование: примитив на ряду свечей, клик и предпросмотр ----
    let onDrawClick = null, onDrawMove = null, onPtrDown = null, onPtrMove = null, onPtrUp = null;
    if (drawingTools) {
      const prim = new DrawingsPrimitive();
      seriesRef.current.candles.attachPrimitive(prim);
      primRef.current = prim;

      // Точка графика из события: цена (с магнитом к свече) и время (к центру бара, если магнит).
      const pointFrom = (param) => {
        if (!param?.point) return null;
        const st = drawRef.current;
        const raw = prim.pointAt(param.point.x, param.point.y);
        if (!raw) return null;
        let { time, price } = raw;
        if (st.magnet) {
          const ts = prim._s.times;
          const l = chart.timeScale().coordinateToLogical(param.point.x);
          if (l != null && ts.length) {
            const idx = Math.max(0, Math.min(ts.length - 1, Math.round(l)));
            time = ts[idx];
            const c = seriesRef.current.candleByTime?.get(time);
            const y2 = prim.yToPrice(param.point.y + 10);
            const thr = y2 != null ? Math.abs(price - Number(y2)) : 0;
            price = snapPrice(price, c, thr);
          }
        }
        return { time, price };
      };

      onDrawClick = (param) => {
        if (Date.now() < (prim._ignoreClick || 0)) return; // клик после перетаскивания — не выбор
        const st = drawRef.current;
        const pt = pointFrom(param);
        if (!pt) return;
        if (st.tool === 'cursor') {
          const id = prim.hitTest(param.point.x, param.point.y);
          setSelectedId(id);
          setRulerDone(null);
          return;
        }
        setRulerDone(null);
        if (st.tool === 'ruler') {
          if (!st.draft) { setDraftPoint(pt); return; }
          setRulerDone({ p1: st.draft, p2: pt });
          setDraftPoint(null);
          return;
        }
        if (st.tool === 'hline' || st.tool === 'vline' || st.tool === 'text') {
          if (st.tool === 'text' && !st.label.trim()) { toast('Сначала введите текст метки'); return; }
          const d = newDrawing({ type: st.tool, p1: pt, color: st.color, label: st.label.trim() });
          st.commit(addDrawing(st.drawings, d));
          setSelectedId(d.id);
          setTool('cursor'); // как на привычных графиках: после рисования — режим выбора, у линии видны кружки
          return;
        }
        if (TWO_POINT.has(st.tool)) {
          if (!st.draft) { setDraftPoint(pt); return; }
          if (st.draft.time === pt.time && st.draft.price === pt.price) return; // та же точка — игнорируем
          const d = newDrawing({ type: st.tool, p1: st.draft, p2: pt, color: st.color });
          st.commit(addDrawing(st.drawings, d));
          setDraftPoint(null);
          setSelectedId(d.id);
          setTool('cursor');
        }
      };

      onDrawMove = (param) => {
        const st = drawRef.current;
        if (!st.draft || !param?.point) { if (prim._s.preview || prim._s.ruler) prim.setState({ preview: null, ruler: null }); return; }
        const pt = pointFrom(param);
        if (!pt) return;
        if (st.tool === 'ruler') {
          const bars = TIMEFRAMES[st.timeframe]?.minutes ? TIMEFRAMES[st.timeframe].minutes * 60 : null;
          const stats = rulerStats({ p1: st.draft, p2: pt, atr: seriesRef.current.atr ?? null, barSeconds: bars });
          prim.setState({ preview: null, ruler: { p1: st.draft, p2: pt, up: stats.delta >= 0, text: rulerText(stats, { priceDigits: 2 }) } });
        } else if (TWO_POINT.has(st.tool)) {
          prim.setState({ ruler: null, preview: { id: '__preview', type: st.tool, p1: st.draft, p2: pt, color: st.color, width: 1 } });
        }
      };
      chart.subscribeClick(onDrawClick);
      chart.subscribeCrosshairMove(onDrawMove);

      // Перетаскивание: за ручку — переставляет точку, за линию — двигает рисунок целиком.
      // Пока тянем, прокрутка графика выключена (иначе он ехал бы вместе с рисунком).
      const el = containerRef.current;
      let drag = null;
      const rel = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      onPtrDown = (e) => {
        const st = drawRef.current;
        if (st.tool !== 'cursor' || (e.button != null && e.button > 0)) return;
        const { x, y } = rel(e);
        const handle = prim.hitHandle(x, y);
        const id = handle?.id || prim.hitTest(x, y);
        if (!id) return;
        const d = st.drawings.find((q) => q.id === id);
        const start = prim.pointAt(x, y);
        if (!d || !start) return;
        drag = { id, which: handle?.which || null, start, orig: d, moved: false, list: null };
        setSelectedId(id);
        chart.applyOptions({ handleScroll: false, handleScale: false });
      };
      onPtrMove = (e) => {
        if (!drag) return;
        const { x, y } = rel(e);
        const pt = prim.pointAt(x, y);
        if (!pt) return;
        drag.moved = true;
        const next = drag.which
          ? movePoint(drag.orig, drag.which, pt)
          : moveDrawing(drag.orig, pt.time - drag.start.time, pt.price - drag.start.price);
        drag.list = drawRef.current.drawings.map((q) => (q.id === drag.id ? next : q));
        drawRef.current.setDraw(drag.list);
      };
      onPtrUp = () => {
        if (!drag) return;
        chart.applyOptions({ handleScroll: true, handleScale: true });
        if (drag.moved && drag.list) { drawRef.current.commit(drag.list); prim._ignoreClick = Date.now() + 250; }
        drag = null;
      };
      el.addEventListener('pointerdown', onPtrDown, true);
      window.addEventListener('pointermove', onPtrMove);
      window.addEventListener('pointerup', onPtrUp);
      window.addEventListener('pointercancel', onPtrUp);
    }

    return () => {
      if (onPtrDown) {
        containerRef.current?.removeEventListener('pointerdown', onPtrDown, true);
        window.removeEventListener('pointermove', onPtrMove);
        window.removeEventListener('pointerup', onPtrUp);
        window.removeEventListener('pointercancel', onPtrUp);
      }
      if (onDrawClick) chart.unsubscribeClick(onDrawClick);
      if (onDrawMove) chart.unsubscribeCrosshairMove(onDrawMove);
      primRef.current = null;
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, []);

  // Candle data — separate effect so overlay toggles don't reload the base series (and
  // don't reset the trader's zoom/scroll).
  useEffect(() => {
    const series = seriesRef.current.candles;
    if (!series || !candles?.length) return;
    series.setData(candles.map((c) => ({
      time: toChartTime(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    // Для рисования: свеча по времени бара (магнит) и ATR (линейка).
    seriesRef.current.candleByTime = new Map(candles.map((c) => [toChartTime(c.date), c]));
    seriesRef.current.atr = atrOf(candles, 14);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  // Состояние слоя рисунков: список, выбранный, времена баров и линейка (когда она «застыла»).
  useEffect(() => {
    const prim = primRef.current;
    if (!prim || !candles?.length) return;
    const bars = TIMEFRAMES[timeframe]?.minutes ? TIMEFRAMES[timeframe].minutes * 60 : 86400;
    let ruler = null;
    if (rulerDone) {
      const stats = rulerStats({ p1: rulerDone.p1, p2: rulerDone.p2, atr: seriesRef.current.atr ?? null, barSeconds: bars });
      ruler = { ...rulerDone, up: stats.delta >= 0, text: rulerText(stats, { priceDigits: 2 }) };
    }
    prim.setState({
      drawings, selectedId, times: candles.map((c) => toChartTime(c.date)), barSec: bars,
      digits: candles[candles.length - 1].close < 10 ? 4 : 2,
      ...(rulerDone || !draftPoint ? { ruler } : {}),
      ...(!draftPoint ? { preview: null } : {}),
    });
  }, [drawings, selectedId, candles, timeframe, rulerDone, draftPoint]);

  // Запрос на рисование снаружи: «Показать фигуру на графике».
  const lastReqKey = useRef(null);
  useEffect(() => {
    if (!drawingTools || !drawRequest || drawRequest.key === lastReqKey.current) return;
    lastReqKey.current = drawRequest.key;
    let list = drawings;
    for (const d of drawRequest.list || []) list = addDrawing(list, d);
    commitDrawings(list);
    setDrawOpen(true);
    setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawRequest]);

  // Клавиши: Delete — удалить выбранное, Esc — отменить начатое и вернуться к курсору.
  useEffect(() => {
    if (!drawingTools || !drawOpen) return undefined;
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Escape') { setDraftPoint(null); setRulerDone(null); setTool('cursor'); setSelectedId(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        commitDrawings(removeDrawing(drawings, selectedId));
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingTools, drawOpen, selectedId, drawings]);

  // Visible range — separate from the data-load effect above because it must ALSO
  // re-run when just the selected trade changes with the SAME candle array (backtest
  // drill-down: `result.candles` stays constant while clicking through different trades
  // in the table, only entryMarker/exitMarker/legs change per click).
  useEffect(() => {
    if (!chartRef.current || !candles?.length) return;
    // Open on the most recent quarter of bars instead of `fitContent()`, which crammed
    // the whole ~2.5-year lookback into one unreadable smear (real user report) — EXCEPT
    // for a backtest's full-history overview (`trades` given), where seeing the whole
    // run at once is the entire point, and EXCEPT for a single trade with a known
    // entry/exit date (backtest drill-down, Journal) — "most recent quarter" is only
    // right by coincidence for Journal (real trades cluster near now); a backtest drill-
    // down trade can sit anywhere in a 10-year history, and this used to always show the
    // tail end of the array regardless of when the trade actually happened (real user
    // report — screenshot of a January 2024 entry showing an unrelated later stretch).
    const n = candles.length;
    const singleTradeDate = entryMarker?.date ?? (legs?.length ? toDate(legs[0].timestampUtc) : null);
    if (trades?.length) {
      chartRef.current.timeScale().fitContent();
    } else if (singleTradeDate && n > 4) {
      const times = candles.map((c) => toChartTime(c.date));
      const entryT = toChartTime(singleTradeDate);
      const exitT = exitMarker?.date ? toChartTime(exitMarker.date)
        : (legs?.length ? toChartTime(toDate(legs[legs.length - 1].timestampUtc)) : entryT);
      const entryIdx = barIndexForTime(entryT, times);
      const exitIdx = barIndexForTime(exitT, times);
      const from = Math.max(0, Math.min(entryIdx, exitIdx) - 20);
      const to = Math.min(n - 1, Math.max(entryIdx, exitIdx) + 20);
      chartRef.current.timeScale().setVisibleLogicalRange({ from, to });
    } else if (n > 4) {
      chartRef.current.timeScale().setVisibleLogicalRange({ from: n - Math.ceil(n / 4), to: n - 1 });
    } else {
      chartRef.current.timeScale().fitContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, entryMarker, exitMarker, legs, trades]);

  // Overlays + markers + P&L + volume. Rebuilt whenever inputs change.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = seriesRef.current.candles;
    if (!chart || !candleSeries || !candles?.length) return;

    (seriesRef.current.overlaySeries || []).forEach((s) => { try { chart.removeSeries(s); } catch {} });
    seriesRef.current.overlaySeries = [];
    (seriesRef.current.priceLines || []).forEach((pl) => { try { candleSeries.removePriceLine(pl); } catch {} });
    seriesRef.current.priceLines = [];
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    const times = candles.map((c) => toChartTime(c.date));
    const closes = candles.map((c) => c.close);
    // Whether moving-indicator lines (EMA, Bollinger) show their last value on the right
    // price axis. Off by default — real user report: EMA200/Bollinger values stacked up
    // on the right scale and made it hard to read ("чтобы не путались глаза").
    const showRV = layers.rightValues;

    if (layers.volume) {
      const volSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
      });
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      volSeries.setData(candles.map((c, i) => ({
        time: times[i], value: c.volume || 0,
        color: withAlpha(c.close >= c.open ? themeColor('--green', '#10b981') : themeColor('--red', '#ef4444'), 0.5),
      })));
      seriesRef.current.overlaySeries.push(volSeries);
    }

    if (layers.sr && patterns?.supportResistance?.length) {
      patterns.supportResistance.forEach((lvl) => {
        seriesRef.current.priceLines.push(candleSeries.createPriceLine({
          price: lvl.price,
          color: lvl.type === 'resistance' ? themeColor('--red', '#ef4444') : themeColor('--green', '#10b981'),
          lineWidth: lvl.isStrongest ? 2 : 1,
          lineStyle: lvl.isStrongest ? 0 : 2,
          axisLabelVisible: showRV,
          title: lvl.isStrongest ? '★' : '',
        }));
      });
    }

    [9, 13, 21, 100, 200].forEach((period) => {
      if (!layers[`ema${period}`]) return;
      const values = ema(closes, period);
      const data = times.map((t, i) => (values[i] != null ? { time: t, value: values[i] } : null)).filter(Boolean);
      if (!data.length) return;
      const line = chart.addSeries(LineSeries, { color: colors[`ema${period}`], lineWidth: 2, title: `EMA${period}`, priceLineVisible: false, lastValueVisible: showRV });
      line.setData(data);
      seriesRef.current.overlaySeries.push(line);
    });

    if (layers.bollinger) {
      const bands = bollingerSeries(closes);
      const upper = [], mid = [], lower = [];
      bands.forEach((b, i) => {
        if (!b) return;
        upper.push({ time: times[i], value: b.upper });
        mid.push({ time: times[i], value: b.mid });
        lower.push({ time: times[i], value: b.lower });
      });
      // Translucent tint under the upper band, fading to transparent — never opaque, so
      // candles are never masked (a prior opaque-mask version hid everything below the
      // lower band, real user report). The tint bleeds a little past the lower band; a
      // true strict fill-between-two-lines needs a custom primitive, out of scope.
      if (upper.length) {
        const tint = withAlpha(colors.bollinger, 0.1);
        const fill = chart.addSeries(AreaSeries, {
          lineVisible: false, topColor: tint, bottomColor: 'rgba(0,0,0,0)', priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false,
        });
        fill.setData(upper);
        seriesRef.current.overlaySeries.push(fill);
      }
      [upper, mid, lower].forEach((data, idx) => {
        if (!data.length) return;
        const line = chart.addSeries(LineSeries, {
          color: colors.bollinger, lineWidth: 1, lineStyle: idx === 1 ? 2 : 0,
          priceLineVisible: false, lastValueVisible: showRV, title: idx === 0 ? 'BB верх' : idx === 1 ? 'BB сред' : 'BB низ',
        });
        line.setData(data);
        seriesRef.current.overlaySeries.push(line);
      });
    }

    if (layers.fibonacci && patterns?.fibonacci?.levels?.length) {
      patterns.fibonacci.levels.forEach((lvl) => {
        seriesRef.current.priceLines.push(candleSeries.createPriceLine({
          price: lvl.price, color: themeColor('--gold', '#f59e0b'), lineWidth: 1, lineStyle: 2,
          axisLabelVisible: showRV, title: `${(lvl.ratio * 100).toFixed(1)}%`,
        }));
      });
    }

    // Calculator plan lines (entry/stop/take typed into the form).
    if (planLines?.entry) {
      seriesRef.current.priceLines.push(candleSeries.createPriceLine({
        price: planLines.entry, color: themeColor('--text-primary', '#f0f4ff'), lineWidth: 1, lineStyle: 0, title: 'Вход',
      }));
    }
    if (planLines?.stop) {
      seriesRef.current.priceLines.push(candleSeries.createPriceLine({
        price: planLines.stop, color: themeColor('--red', '#ef4444'), lineWidth: 1, lineStyle: 3, title: 'Стоп',
      }));
    }
    if (planLines?.take) {
      seriesRef.current.priceLines.push(candleSeries.createPriceLine({
        price: planLines.take, color: themeColor('--green', '#10b981'), lineWidth: 1, lineStyle: 3, title: 'Тейк',
      }));
    }

    // Entry line + P&L zone (Journal trades). The zone is a Baseline series: baseline at
    // the average entry price, a flat line at the exit price over the trade's time span,
    // so the region between them fills green (exit above entry) or red (below), bounded to
    // the days the trade was actually held.
    if (isTrade && layers.pnl) {
      seriesRef.current.priceLines.push(candleSeries.createPriceLine({
        price: entryPrice, color: themeColor('--text-primary', '#f0f4ff'), lineWidth: 1, lineStyle: 0, title: 'Ср. вход',
      }));
      if (exitPrice != null && legs?.length) {
        const legTimes = legs.map((l) => barTimeForLeg(toChartTime(toDate(l.timestampUtc)), times));
        const firstBar = Math.min(...legTimes);
        const lastBar = Math.max(...legTimes);
        const zoneData = times.filter((t) => t >= firstBar && t <= lastBar).map((t) => ({ time: t, value: exitPrice }));
        if (zoneData.length) {
          const up = exitPrice >= entryPrice;
          const zone = chart.addSeries(BaselineSeries, {
            baseValue: { type: 'price', price: entryPrice },
            topLineColor: themeColor('--green', '#10b981'), bottomLineColor: themeColor('--red', '#ef4444'),
            topFillColor1: withAlpha(themeColor('--green', '#10b981'), 0.25), topFillColor2: withAlpha(themeColor('--green', '#10b981'), 0.05),
            bottomFillColor1: withAlpha(themeColor('--red', '#ef4444'), 0.05), bottomFillColor2: withAlpha(themeColor('--red', '#ef4444'), 0.25),
            lineWidth: 2, priceLineVisible: false, lastValueVisible: showRV, crosshairMarkerVisible: false,
            title: up ? 'Выход (прибыль)' : 'Выход (убыток)',
          });
          zone.setData(zoneData);
          seriesRef.current.overlaySeries.push(zone);
        }
      }
    }

    if (layers.rsi) {
      const rsiValues = rsi(closes, 14);
      const data = times.map((t, i) => (rsiValues[i] != null ? { time: t, value: rsiValues[i] } : null)).filter(Boolean);
      if (data.length) {
        const paneIndex = chart.panes().length;
        const rsiLine = chart.addSeries(LineSeries, { color: themeColor('--blue', '#3b82f6'), lineWidth: 2, title: 'RSI', priceLineVisible: false }, paneIndex);
        rsiLine.setData(data);
        rsiLine.createPriceLine({ price: 70, color: themeColor('--red', '#ef4444'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
        rsiLine.createPriceLine({ price: 30, color: themeColor('--green', '#10b981'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
        chart.panes()[paneIndex]?.setHeight(100);
        seriesRef.current.overlaySeries.push(rsiLine);
      }
    }

    if (layers.macd) {
      const { macdLine, signalLine, histogram } = macd(closes);
      const histData = times.map((t, i) => (histogram[i] != null
        ? { time: t, value: histogram[i], color: histogram[i] >= 0 ? themeColor('--green', '#10b981') : themeColor('--red', '#ef4444') }
        : null)).filter(Boolean);
      const macdData = times.map((t, i) => (macdLine[i] != null ? { time: t, value: macdLine[i] } : null)).filter(Boolean);
      const signalData = times.map((t, i) => (signalLine[i] != null ? { time: t, value: signalLine[i] } : null)).filter(Boolean);
      if (histData.length) {
        const paneIndex = chart.panes().length;
        const histSeries = chart.addSeries(HistogramSeries, { title: 'MACD', priceLineVisible: false }, paneIndex);
        histSeries.setData(histData);
        const macdLineSeries = chart.addSeries(LineSeries, { color: themeColor('--blue', '#3b82f6'), lineWidth: 1, priceLineVisible: false }, paneIndex);
        macdLineSeries.setData(macdData);
        const signalLineSeries = chart.addSeries(LineSeries, { color: themeColor('--gold', '#f59e0b'), lineWidth: 1, priceLineVisible: false }, paneIndex);
        signalLineSeries.setData(signalData);
        chart.panes()[paneIndex]?.setHeight(100);
        seriesRef.current.overlaySeries.push(histSeries, macdLineSeries, signalLineSeries);
      }
    }

    // Markers (one per bar, ×N-collapsed) + the fill map the tooltip reads on hover.
    const markerColors = {
      red: themeColor('--red', '#ef4444'), green: themeColor('--green', '#10b981'),
      gold: themeColor('--gold', '#f59e0b'), blue: themeColor('--blue', '#3b82f6'),
    };
    let markers = [];
    if (trades?.length) {
      markers = buildTradesMarkers(trades, markerColors, layers.tradeLabels);
      fillsByBarRef.current = new Map();
    } else if (layers.pnl || !isTrade) {
      const built = buildMarkersAndFills(legs, direction, times, markerColors);
      markers = built.markers;
      fillsByBarRef.current = built.fillsByBar;
      if (!markers.length) {
        // Fallback for trades saved with no leg history (e.g. from the Calculator).
        if (entryMarker) markers.push({ time: barTimeForLeg(toChartTime(entryMarker.date), times), position: entryMarker.direction === 'short' ? 'aboveBar' : 'belowBar', color: entryMarker.direction === 'short' ? markerColors.red : markerColors.green, shape: entryMarker.direction === 'short' ? 'arrowDown' : 'arrowUp', text: 'Вход' });
        if (exitMarker) markers.push({ time: barTimeForLeg(toChartTime(exitMarker.date), times), position: 'aboveBar', color: markerColors.gold, shape: 'circle', text: 'Выход' });
        markers.sort((a, b) => a.time - b.time);
      }
    } else {
      fillsByBarRef.current = new Map();
    }
    // Метки «система вышла бы здесь» — рядом с реальными операциями трейдера, другой формы
    // и цвета, чтобы их нельзя было принять за настоящую сделку.
    if (systemMarkers?.length && times.length) {
      const accent = themeColor('--accent-primary', '#4f46e5');
      systemMarkers.forEach((m) => {
        if (!m?.date) return;
        markers.push({
          time: barTimeForLeg(toChartTime(toDate(m.date)), times),
          position: 'aboveBar', color: accent, shape: 'square', text: m.text || 'Система',
        });
      });
      markers.sort((a, b) => a.time - b.time);
    }
    if (!seriesRef.current.markersPlugin) {
      seriesRef.current.markersPlugin = createSeriesMarkers(candleSeries, markers);
    } else {
      seriesRef.current.markersPlugin.setMarkers(markers);
    }
  }, [candles, patterns, layers, entryMarker, exitMarker, legs, direction, entryPrice, exitPrice, planLines, colors, isTrade, trades, systemMarkers]);

  const rsiMacdPanes = (layers.rsi ? 110 : 0) + (layers.macd ? 110 : 0);
  // Real user report 2026-08-17: fullscreen used to hard-code `calc(100vh - 150px)` for
  // the chart, assuming a fixed 150px was always enough for the header + layer-toggle
  // row above it — with several layers on, that row wraps to 2-3 lines and eats more
  // than 150px, pushing the bottom of the chart (and its RSI/MACD sub-panes) past the
  // viewport with no obvious way to see it (the outer wrapper's overflow:auto just made
  // the WHOLE overlay scroll instead of clipping, but nothing signaled that). Flexbox
  // instead of a magic number: header + toggle row keep their natural height (however
  // many lines they wrap to), the chart takes whatever's actually left — never a guess.
  const chartHeight = fullscreen ? '100%' : `${(height ?? 300) + rsiMacdPanes}px`;
  const visibleLayers = LAYER_DEFS.filter((l) => (!l.tradeOnly || isTrade) && (!l.overviewOnly || trades?.length));

  const content = (
    <div style={fullscreen ? { position:'fixed', inset:0, zIndex:9998, background:'var(--bg-surface)', padding:16, display:'flex', flexDirection:'column', overflow:'hidden' } : undefined}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, marginBottom:8, flexShrink:0}}>
        <div style={{fontSize:14, fontWeight:700, color:'var(--text-primary)'}}>{ticker}</div>
        <div style={{display:'flex', gap:4, alignItems:'center'}}>
          {timeframeOptions?.length > 0 && timeframeOptions.map((tf) => (
            <button
              key={tf.key}
              className={`btn btn-sm ${tf.key === timeframe ? 'btn-primary' : 'btn-ghost'}`}
              style={{fontSize:11, padding:'3px 8px'}}
              onClick={() => onTimeframeChange?.(tf.key)}
            >{TIMEFRAMES[tf.key]?.label || tf.label}</button>
          ))}
          <button
            className="btn btn-ghost btn-sm"
            style={{fontSize:13, padding:'3px 8px'}}
            onClick={() => {
              setFullscreen((f) => !f);
              // autoSize должен сам подхватить новую высоту контейнера, но переход в
              // fixed-оверлей меняет размер синхронно с этим же рендером — ResizeObserver
              // иногда не успевает сработать вовремя, и подписи EMA9/EMA13 сверху слева
              // остаются посчитанными под старую (маленькую) ширину и съезжают за край
              // (реальная жалоба). Один принудительный resize следующим кадром чинит это,
              // ничего не меняя, когда всё и так посчиталось верно.
              requestAnimationFrame(() => {
                if (chartRef.current && containerRef.current) {
                  chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
                }
              });
            }}
            title={fullscreen ? 'Свернуть' : 'На весь экран'}
          >{fullscreen ? '✕' : '⛶'}</button>
        </div>
      </div>
      <div className="cc-layers-wrap">
        <button
          type="button"
          className="cc-layers-toggle"
          onClick={() => setIndicatorsOpen((v) => !v)}
        >
          Индикаторы {indicatorsOpen ? '▲' : '▼'}
        </button>
        <div className={`cc-layers-row ${indicatorsOpen ? 'open' : ''}`}>
          {visibleLayers.map((l) => (
            <span key={l.key} style={{display:'inline-flex', alignItems:'center', gap:4}}>
              <button
                className={`badge ${layers[l.key] ? 'badge-blue' : ''}`}
                style={{cursor:'pointer', border:'none', fontSize:11}}
                onClick={() => toggleLayer(l.key)}
              >{layers[l.key] ? '✓ ' : ''}{l.label}</button>
              {l.colorable && <ColorPicker color={colors[l.key]} onChange={(v) => setColor(l.key, v)} />}
            </span>
          ))}
        </div>
      </div>
      {drawingTools && (
        <ChartDrawingToolbar
          open={drawOpen}
          onToggle={() => { setDrawOpen((v) => !v); if (drawOpen) { setTool('cursor'); setDraftPoint(null); } }}
          tool={tool}
          onTool={(t) => { setTool(t); setDraftPoint(null); setRulerDone(null); }}
          color={drawColor} onColor={(c) => {
            setDrawColor(c);
            if (selectedId) commitDrawings(drawings.map((d) => (d.id === selectedId ? { ...d, color: c } : d)));
          }}
          magnet={magnet} onMagnet={() => setMagnet((v) => !v)}
          label={textLabel} onLabel={setTextLabel}
          hasSelected={!!selectedId}
          onDeleteSelected={() => { if (selectedId) { commitDrawings(removeDrawing(drawings, selectedId)); setSelectedId(null); } }}
          count={drawings.length}
          onClearAll={() => { if (drawings.length) { commitDrawings([]); setSelectedId(null); } }}
          hint={
            tool === 'cursor' ? 'Кликните по рисунку, чтобы выбрать его; тяните за линию — двигаете целиком, за кружок — меняете точку. Цвет меняется сразу, Delete — удалить.'
              : draftPoint ? `${TOOL_LABELS[tool]}: кликните по второй точке (Esc — отмена).`
                : tool === 'ruler' ? 'Линейка: кликните по двум точкам — покажет ход в рублях, процентах, барах и ATR.'
                  : tool === 'hline' || tool === 'vline' ? `${TOOL_LABELS[tool]}: один клик по графику.`
                    : tool === 'text' ? 'Введите текст и кликните по графику.'
                      : `${TOOL_LABELS[tool]}: кликните по первой точке.`
          }
        />
      )}
      <div style={fullscreen ? {position:'relative', flex:1, minHeight:0} : {position:'relative'}}>
        <div ref={containerRef} style={{width:'100%', height:chartHeight}} />
        <div ref={tooltipRef} style={{
          position:'absolute', display:'none', pointerEvents:'none', zIndex:5, width:180,
          fontSize:11, lineHeight:1.5, color:'var(--text-secondary)', background:'var(--bg-surface-2)',
          border:'1px solid var(--border-subtle)', borderRadius:8, padding:'6px 8px', boxShadow:'0 4px 12px rgba(0,0,0,0.3)',
        }} />
      </div>
    </div>
  );

  // В полноэкранном режиме оверлей уходит порталом прямо в <body>. Причина: .main-content
  // имеет position:relative + z-index:1, то есть образует собственный слой, и position:fixed
  // внутри него остаётся ВНУТРИ этого слоя. Боковое меню (z-index:100) — сосед этого слоя,
  // поэтому рисовалось ПОВЕРХ полноэкранного графика и закрывало его левый край: кнопки
  // «Уровни S/R», EMA9 и EMA13 просто уходили под меню, а ряд начинался с осиротевшего
  // кружка выбора цвета (реальная жалоба со скриншотом — «индикаторы уезжают за край»).
  // Содержимое всегда живёт в одном и том же DOM-узле (host) и просто переносится: в <body> при полном
  // экране, обратно на место — при выходе. Раньше при переключении React пересоздавал контейнер, а график
  // оставался привязан к старому (удалённому) — поэтому после входа/выхода из полного экрана было пусто.
  return (
    <>
      <div ref={slotRef} />
      {createPortal(content, hostEl)}
    </>
  );
}
