// src/components/shared/CandleChart.js
//
// Candle chart with S/R/EMA/Bollinger/Fibonacci/RSI/MACD/volume overlays plus trade
// markers and a P&L zone, built on Lightweight Charts (TradingView, Apache-2.0, no
// watermark requirement outside the paid widget). Shared by Calculator (live pre-trade),
// Journal (frozen "as of entry" view with fill markers), and Radar. Data always comes
// from the same `fetchDailyCandles` used for indicators — this component doesn't know or
// care whether it's MOEX or Tinkoff behind it.
import React, { useEffect, useRef, useState } from 'react';
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, AreaSeries, HistogramSeries, BaselineSeries, createSeriesMarkers } from 'lightweight-charts';
import { ema, bollingerSeries, rsi, macd } from '../../services/analytics/indicators';
import { TIMEFRAMES } from '../../services/marketData/candles';

// `tradeOnly` chips only make sense on a real trade (Journal) — hidden in Calculator/
// Radar, where there's no entry/exit to draw. `colorable` chips get a color swatch.
const LAYER_DEFS = [
  { key: 'sr', label: 'Уровни S/R', defaultOn: true },
  { key: 'ema9', label: 'EMA9', defaultOn: false, colorable: true },
  { key: 'ema100', label: 'EMA100', defaultOn: false, colorable: true },
  { key: 'ema200', label: 'EMA200', defaultOn: false, colorable: true },
  { key: 'bollinger', label: 'Боллинджер', defaultOn: false, colorable: true },
  { key: 'fibonacci', label: 'Фибоначчи', defaultOn: false },
  { key: 'rsi', label: 'RSI', defaultOn: false },
  { key: 'macd', label: 'MACD', defaultOn: false },
  { key: 'volume', label: 'Объём', defaultOn: false },
  { key: 'pnl', label: 'Вход/выход', defaultOn: true, tradeOnly: true },
  { key: 'rightValues', label: 'Цифры справа', defaultOn: false },
];

const DEFAULT_COLORS_KEY = 'traderpro-chart-colors';
const DEFAULT_COLOR_FALLBACKS = {
  ema9: '#3b82f6', ema100: '#f59e0b', ema200: '#ef4444', bollinger: '#9ca3af',
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
}) {
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const fillsByBarRef = useRef(new Map());
  const isTrade = entryPrice != null;

  const [layers, setLayers] = useState(() =>
    Object.fromEntries(LAYER_DEFS.map((l) => [l.key, l.defaultOn]))
  );
  const [colors, setColors] = useState(() => ({ ...DEFAULT_COLOR_FALLBACKS, ...loadSavedColors() }));
  const [fullscreen, setFullscreen] = useState(false);

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

    return () => {
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
    // Open on the most recent quarter of bars instead of `fitContent()`, which crammed
    // the whole ~2.5-year lookback into one unreadable smear (real user report).
    const n = candles.length;
    if (n > 4) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: n - Math.ceil(n / 4), to: n - 1 });
    } else {
      chartRef.current?.timeScale().fitContent();
    }
  }, [candles]);

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

    [9, 100, 200].forEach((period) => {
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
    if (layers.pnl || !isTrade) {
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
    if (!seriesRef.current.markersPlugin) {
      seriesRef.current.markersPlugin = createSeriesMarkers(candleSeries, markers);
    } else {
      seriesRef.current.markersPlugin.setMarkers(markers);
    }
  }, [candles, patterns, layers, entryMarker, exitMarker, legs, direction, entryPrice, exitPrice, planLines, colors, isTrade]);

  const rsiMacdPanes = (layers.rsi ? 110 : 0) + (layers.macd ? 110 : 0);
  const chartHeight = fullscreen ? `calc(100vh - 150px)` : `${300 + rsiMacdPanes}px`;
  const visibleLayers = LAYER_DEFS.filter((l) => !l.tradeOnly || isTrade);

  return (
    <div style={fullscreen ? { position:'fixed', inset:0, zIndex:9998, background:'var(--bg-surface)', padding:16, overflow:'auto' } : undefined}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, marginBottom:8}}>
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
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? 'Свернуть' : 'На весь экран'}
          >{fullscreen ? '✕' : '⛶'}</button>
        </div>
      </div>
      <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:8, alignItems:'center'}}>
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
      <div style={{position:'relative'}}>
        <div ref={containerRef} style={{width:'100%', height:chartHeight}} />
        <div ref={tooltipRef} style={{
          position:'absolute', display:'none', pointerEvents:'none', zIndex:5, width:180,
          fontSize:11, lineHeight:1.5, color:'var(--text-secondary)', background:'var(--bg-surface-2)',
          border:'1px solid var(--border-subtle)', borderRadius:8, padding:'6px 8px', boxShadow:'0 4px 12px rgba(0,0,0,0.3)',
        }} />
      </div>
    </div>
  );
}
