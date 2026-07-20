// src/components/shared/CandleChart.js
//
// Candle chart with S/R/EMA/Bollinger/Fibonacci overlays, built on Lightweight Charts
// (TradingView, Apache-2.0, no watermark requirement outside the paid widget). Shared by
// Calculator (live pre-trade), Journal (frozen "as of entry" view with entry/exit
// markers), and later Radar. Data always comes from the same `fetchDailyCandles` used for
// indicators — this component doesn't know or care whether it's MOEX or Tinkoff behind it.
import React, { useEffect, useRef, useState } from 'react';
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { ema, bollingerSeries } from '../../services/analytics/indicators';
import { TIMEFRAMES } from '../../services/marketData/candles';

const LAYER_DEFS = [
  { key: 'sr', label: 'Уровни S/R', defaultOn: true },
  { key: 'ema9', label: 'EMA9', defaultOn: false },
  { key: 'ema100', label: 'EMA100', defaultOn: false },
  { key: 'ema200', label: 'EMA200', defaultOn: false },
  { key: 'bollinger', label: 'Боллинджер', defaultOn: false },
  { key: 'fibonacci', label: 'Фибоначчи', defaultOn: false },
];

function themeColor(varName, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

// Candle `date` is a JS Date; Lightweight Charts wants unix seconds for intraday series
// (using `time` as a number puts it in “business day or UTC timestamp” mode, which is
// what we want here — plain daily-bar business-day mode would collapse intraday bars
// that share a calendar day onto a single x-position).
function toChartTime(date) {
  return Math.floor(date.getTime() / 1000);
}

export default function CandleChart({
  candles,
  patterns,
  ticker,
  timeframe,
  timeframeOptions,
  onTimeframeChange,
  entryMarker, // { date, price, direction: 'long'|'short' }
  exitMarker,  // { date, price }
  planLines,   // { entry, stop, take }
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const [layers, setLayers] = useState(() =>
    Object.fromEntries(LAYER_DEFS.map((l) => [l.key, l.defaultOn]))
  );

  const toggleLayer = (key) => setLayers((s) => ({ ...s, [key]: !s[key] }));

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
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Overlays: S/R horizontal lines, EMA lines, Bollinger band, Fibonacci dashed lines,
  // entry/exit markers, plan lines. Redrawn whenever candles/patterns/layers/markers
  // change — cheap enough (a handful of price lines and a couple of series) not to need
  // finer-grained diffing.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = seriesRef.current.candles;
    if (!chart || !candleSeries || !candles?.length) return;

    // Clear previous overlay series/price-lines before redrawing.
    (seriesRef.current.overlaySeries || []).forEach((s) => { try { chart.removeSeries(s); } catch {} });
    seriesRef.current.overlaySeries = [];
    (seriesRef.current.priceLines || []).forEach((pl) => { try { candleSeries.removePriceLine(pl); } catch {} });
    seriesRef.current.priceLines = [];

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
      const color = period === 9 ? themeColor('--blue', '#3b82f6')
        : period === 100 ? themeColor('--gold', '#f59e0b')
        : themeColor('--red', '#ef4444');
      const line = chart.addSeries(LineSeries, { color, lineWidth: 2, title: `EMA${period}`, priceLineVisible: false });
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
      const bandColor = themeColor('--text-muted', '#9ca3af');
      [upper, mid, lower].forEach((data, idx) => {
        if (!data.length) return;
        const line = chart.addSeries(LineSeries, {
          color: bandColor, lineWidth: idx === 1 ? 1 : 1, lineStyle: idx === 1 ? 2 : 0,
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

    const markers = [];
    if (entryMarker) {
      markers.push({
        time: toChartTime(entryMarker.date),
        position: entryMarker.direction === 'short' ? 'aboveBar' : 'belowBar',
        color: entryMarker.direction === 'short' ? themeColor('--red', '#ef4444') : themeColor('--green', '#10b981'),
        shape: entryMarker.direction === 'short' ? 'arrowDown' : 'arrowUp',
        text: 'Вход',
      });
    }
    if (exitMarker) {
      markers.push({
        time: toChartTime(exitMarker.date),
        position: 'aboveBar',
        color: themeColor('--gold', '#f59e0b'),
        shape: 'circle',
        text: 'Выход',
      });
    }
    markers.sort((a, b) => a.time - b.time);
    if (!seriesRef.current.markersPlugin) {
      seriesRef.current.markersPlugin = createSeriesMarkers(candleSeries, markers);
    } else {
      seriesRef.current.markersPlugin.setMarkers(markers);
    }
  }, [candles, patterns, layers, entryMarker, exitMarker, planLines]);

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
      <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:8}}>
        {LAYER_DEFS.map((l) => (
          <button
            key={l.key}
            className={`badge ${layers[l.key] ? 'badge-blue' : ''}`}
            style={{cursor:'pointer', border:'none', fontSize:11}}
            onClick={() => toggleLayer(l.key)}
          >{layers[l.key] ? '✓ ' : ''}{l.label}</button>
        ))}
      </div>
      <div ref={containerRef} style={{width:'100%', height:360}} />
    </div>
  );
}
