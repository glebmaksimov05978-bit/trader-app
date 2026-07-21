// src/components/shared/CandleChart.js
//
// Candle chart with S/R/EMA/Bollinger/Fibonacci/RSI/MACD overlays, built on Lightweight
// Charts (TradingView, Apache-2.0, no watermark requirement outside the paid widget).
// Shared by Calculator (live pre-trade), Journal (frozen "as of entry" view with
// entry/exit markers), and later Radar. Data always comes from the same
// `fetchDailyCandles` used for indicators — this component doesn't know or care whether
// it's MOEX or Tinkoff behind it.
import React, { useEffect, useRef, useState } from 'react';
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, AreaSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts';
import { ema, bollingerSeries, rsi, macd } from '../../services/analytics/indicators';
import { TIMEFRAMES } from '../../services/marketData/candles';

const LAYER_DEFS = [
  { key: 'sr', label: 'Уровни S/R', defaultOn: true },
  { key: 'ema9', label: 'EMA9', defaultOn: false, colorable: true },
  { key: 'ema100', label: 'EMA100', defaultOn: false, colorable: true },
  { key: 'ema200', label: 'EMA200', defaultOn: false, colorable: true },
  { key: 'bollinger', label: 'Боллинджер', defaultOn: false, colorable: true },
  { key: 'fibonacci', label: 'Фибоначчи', defaultOn: false },
  { key: 'rsi', label: 'RSI', defaultOn: false },
  { key: 'macd', label: 'MACD', defaultOn: false },
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

// Adds an alpha channel to a hex color for translucent fills (the Bollinger band tint) —
// colors here are always either a hex string from the trader's own color picker or one
// of our theme hex fallbacks, never a named CSS color, so a simple hex→rgba is enough.
function withAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Candle `date` is a JS Date; Lightweight Charts wants unix seconds for intraday series
// (using `time` as a number puts it in “business day or UTC timestamp” mode, which is
// what we want here — plain daily-bar business-day mode would collapse intraday bars
// that share a calendar day onto a single x-position).
function toChartTime(date) {
  return Math.floor(date.getTime() / 1000);
}

// Trade legs come straight из Firestore, where a JS Date written on import round-trips
// back as a Firestore Timestamp object ({ seconds, nanoseconds }), not a Date/ISO string
// — `new Date(firestoreTimestamp)` silently produces an Invalid Date (NaN), which made
// every leg marker vanish without a single console error (real user report: markers that
// worked before this went quiet again after switching to leg-by-leg markers). Same
// coercion Journal.js already uses for its own leg table (`fmtDateTime`).
function toDate(d) {
  if (d instanceof Date) return d;
  if (d?.seconds != null) return new Date(d.seconds * 1000);
  return new Date(d);
}

// One marker per fill, not one entry + one exit — a position built or unwound over
// several orders (докупки, partial closes) needs every leg on the chart, or the trader
// can't tell "when did I actually add" from "when did I finally get out" (real user
// report: chart only showed a single entry/exit pair, hiding every докупка and making
// the exit marker look randomly placed since it wasn't the trade's actual last fill).
function legsToMarkers(legs, direction, colors) {
  if (!legs?.length) return [];
  const totalOpened = legs.filter((l) => l.type === 'open').reduce((s, l) => s + l.quantity, 0);
  let openCount = 0;
  let closedSoFar = 0;
  return legs.map((leg) => {
    const time = toChartTime(toDate(leg.timestampUtc));
    if (leg.type === 'open') {
      openCount += 1;
      return {
        time,
        position: direction === 'short' ? 'aboveBar' : 'belowBar',
        color: direction === 'short' ? colors.red : colors.green,
        shape: direction === 'short' ? 'arrowDown' : 'arrowUp',
        text: openCount === 1 ? 'Вход' : 'Докупка',
      };
    }
    closedSoFar += leg.quantity;
    const isFinal = closedSoFar >= totalOpened;
    return {
      time,
      position: 'aboveBar',
      color: isFinal ? colors.gold : colors.blue,
      shape: 'circle',
      text: isFinal ? 'Выход' : 'Частичный выход',
    };
  });
}

// Small circular color swatch + native color input — the trader asked to pick each
// EMA/Bollinger color themselves rather than live with our fixed blue/gold/red scheme.
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
  entryMarker, // { date, price, direction: 'long'|'short' } — fallback when `legs` isn't available
  exitMarker,  // { date, price } — fallback when `legs` isn't available
  legs,        // trade.legs: [{ type: 'open'|'close', side, quantity, price, timestampUtc }, ...]
  direction,   // 'long' | 'short' — needed alongside `legs` to pick arrow direction/color
  planLines,   // { entry, stop, take }
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const [layers, setLayers] = useState(() =>
    Object.fromEntries(LAYER_DEFS.map((l) => [l.key, l.defaultOn]))
  );
  const [colors, setColors] = useState(() => ({ ...DEFAULT_COLOR_FALLBACKS, ...loadSavedColors() }));

  const toggleLayer = (key) => setLayers((s) => ({ ...s, [key]: !s[key] }));
  const setColor = (key, value) => setColors((s) => {
    const next = { ...s, [key]: value };
    try { localStorage.setItem(DEFAULT_COLORS_KEY, JSON.stringify(next)); } catch {}
    return next;
  });

  // Chart instance created once per mount, destroyed on unmount — theme colors are read
  // fresh each time since the trader can flip light/dark between mounts.
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
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, []);

  // Candle data itself — separate effect so overlay toggles below don't reload the base
  // series (and don't reset the trader's current zoom/scroll position).
  useEffect(() => {
    const series = seriesRef.current.candles;
    if (!series || !candles?.length) return;
    series.setData(candles.map((c) => ({
      time: toChartTime(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    // `fitContent()` crammed the ENTIRE fetched lookback (up to ~2.5 years on D1) into
    // one screen, rendering as an unreadable smear — real user report, asked for roughly
    // 4× closer by default. Opens on the most recent quarter of bars instead; the
    // trader can still scroll/zoom out from there to see the full history.
    const n = candles.length;
    if (n > 4) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: n - Math.ceil(n / 4), to: n - 1 });
    } else {
      chartRef.current?.timeScale().fitContent();
    }
  }, [candles]);

  // Overlays: S/R horizontal lines, EMA lines, Bollinger band (with fill), Fibonacci
  // dashed lines, RSI/MACD panes, entry/exit markers, plan lines. Redrawn whenever
  // candles/patterns/layers/markers/colors change — cheap enough (a handful of price
  // lines and a couple of series) not to need finer-grained diffing.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = seriesRef.current.candles;
    if (!chart || !candleSeries || !candles?.length) return;

    // Clear previous overlay series/price-lines before redrawing.
    (seriesRef.current.overlaySeries || []).forEach((s) => { try { chart.removeSeries(s); } catch {} });
    seriesRef.current.overlaySeries = [];
    (seriesRef.current.priceLines || []).forEach((pl) => { try { candleSeries.removePriceLine(pl); } catch {} });
    seriesRef.current.priceLines = [];
    // RSI/MACD live in their own panes below the price chart — drop every pane past the
    // main one (index 0) and rebuild from scratch, same brute-force-but-cheap approach
    // as the overlay series above.
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    const times = candles.map((c) => toChartTime(c.date));
    const closes = candles.map((c) => c.close);

    if (layers.sr && patterns?.supportResistance?.length) {
      patterns.supportResistance.forEach((lvl) => {
        const pl = candleSeries.createPriceLine({
          price: lvl.price,
          color: lvl.type === 'resistance' ? themeColor('--red', '#ef4444') : themeColor('--green', '#10b981'),
          lineWidth: lvl.isStrongest ? 2 : 1,
          lineStyle: lvl.isStrongest ? 0 : 2, // solid for the strongest, dashed otherwise
          axisLabelVisible: true,
          title: lvl.isStrongest ? '★' : '',
        });
        seriesRef.current.priceLines.push(pl);
      });
    }

    [9, 100, 200].forEach((period) => {
      if (!layers[`ema${period}`]) return;
      const values = ema(closes, period);
      const data = times.map((t, i) => (values[i] != null ? { time: t, value: values[i] } : null)).filter(Boolean);
      if (!data.length) return;
      const line = chart.addSeries(LineSeries, { color: colors[`ema${period}`], lineWidth: 2, title: `EMA${period}`, priceLineVisible: false });
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
      // A translucent Area series under the upper band, tinted down to the BOTTOM of
      // the visible price scale (not stopping at the lower band — Lightweight Charts
      // has no built-in "fill only between two lines" primitive), then the candlestick
      // series is re-added on top so it always paints over the tint instead of getting
      // masked by it. A previous version tried to erase the area below the lower band
      // with a second opaque Area series — that painted OVER the candles too (real user
      // report: "всё что под нижней полосой пропадает"), which is worse than an
      // imperfect tint. This version never hides real candle data, only tints behind it.
      if (upper.length) {
        const tint = withAlpha(colors.bollinger, 0.1);
        const fillUpper = chart.addSeries(AreaSeries, {
          lineVisible: false, topColor: tint, bottomColor: 'rgba(0,0,0,0)', priceLineVisible: false, crosshairMarkerVisible: false,
        });
        fillUpper.setData(upper);
        seriesRef.current.overlaySeries.push(fillUpper);
      }
      const bandColor = colors.bollinger;
      [upper, mid, lower].forEach((data, idx) => {
        if (!data.length) return;
        const line = chart.addSeries(LineSeries, {
          color: bandColor, lineWidth: 1, lineStyle: idx === 1 ? 2 : 0,
          priceLineVisible: false, title: idx === 0 ? 'BB верх' : idx === 1 ? 'BB сред' : 'BB низ',
        });
        line.setData(data);
        seriesRef.current.overlaySeries.push(line);
      });
    }

    if (layers.fibonacci && patterns?.fibonacci?.levels?.length) {
      patterns.fibonacci.levels.forEach((lvl) => {
        const pl = candleSeries.createPriceLine({
          price: lvl.price,
          color: themeColor('--gold', '#f59e0b'),
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `${(lvl.ratio * 100).toFixed(1)}%`,
        });
        seriesRef.current.priceLines.push(pl);
      });
    }

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

    // RSI pane — its own scale (0-100) with the classic 30/70 reference lines, only
    // built when the trader turns it on (off by default, same as every other layer).
    if (layers.rsi) {
      const rsiValues = rsi(closes, 14);
      const data = times.map((t, i) => (rsiValues[i] != null ? { time: t, value: rsiValues[i] } : null)).filter(Boolean);
      if (data.length) {
        const paneIndex = chart.panes().length;
        const rsiLine = chart.addSeries(LineSeries, {
          color: themeColor('--blue', '#3b82f6'), lineWidth: 2, title: 'RSI', priceLineVisible: false,
        }, paneIndex);
        rsiLine.setData(data);
        rsiLine.createPriceLine({ price: 70, color: themeColor('--red', '#ef4444'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
        rsiLine.createPriceLine({ price: 30, color: themeColor('--green', '#10b981'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
        chart.panes()[paneIndex]?.setHeight(100);
        seriesRef.current.overlaySeries.push(rsiLine);
      }
    }

    // MACD pane — histogram + MACD/signal lines, same layout traders expect from a
    // terminal.
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

    const markerColors = {
      red: themeColor('--red', '#ef4444'),
      green: themeColor('--green', '#10b981'),
      gold: themeColor('--gold', '#f59e0b'),
      blue: themeColor('--blue', '#3b82f6'),
    };
    let markers = legsToMarkers(legs, direction, markerColors);
    if (!markers.length) {
      // Fallback for trades with no leg history (e.g. saved straight from the
      // Calculator) — a single entry/exit pair is all there is to show.
      if (entryMarker) {
        markers.push({
          time: toChartTime(entryMarker.date),
          position: entryMarker.direction === 'short' ? 'aboveBar' : 'belowBar',
          color: entryMarker.direction === 'short' ? markerColors.red : markerColors.green,
          shape: entryMarker.direction === 'short' ? 'arrowDown' : 'arrowUp',
          text: 'Вход',
        });
      }
      if (exitMarker) {
        markers.push({
          time: toChartTime(exitMarker.date),
          position: 'aboveBar',
          color: markerColors.gold,
          shape: 'circle',
          text: 'Выход',
        });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    if (!seriesRef.current.markersPlugin) {
      seriesRef.current.markersPlugin = createSeriesMarkers(candleSeries, markers);
    } else {
      seriesRef.current.markersPlugin.setMarkers(markers);
    }
  }, [candles, patterns, layers, entryMarker, exitMarker, legs, direction, planLines, colors]);

  return (
    <div>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, marginBottom:8}}>
        <div style={{fontSize:14, fontWeight:700, color:'var(--text-primary)'}}>{ticker}</div>
        {timeframeOptions?.length > 0 && (
          <div style={{display:'flex', gap:4}}>
            {timeframeOptions.map((tf) => (
              <button
                key={tf.key}
                className={`btn btn-sm ${tf.key === timeframe ? 'btn-primary' : 'btn-ghost'}`}
                style={{fontSize:11, padding:'3px 8px'}}
                onClick={() => onTimeframeChange?.(tf.key)}
              >{TIMEFRAMES[tf.key]?.label || tf.label}</button>
            ))}
          </div>
        )}
      </div>
      <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:8, alignItems:'center'}}>
        {LAYER_DEFS.map((l) => (
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
      <div ref={containerRef} style={{width:'100%', height: 300 + (layers.rsi ? 110 : 0) + (layers.macd ? 110 : 0)}} />
    </div>
  );
}
