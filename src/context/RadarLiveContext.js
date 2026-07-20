// src/context/RadarLiveContext.js
//
// Live polling for the Radar watchlist — pulled out of Dashboard.js into a provider
// mounted in AppLayout (above the router <Outlet/>) so it survives navigating to other
// pages. Dashboard previously owned this state itself, which meant switching to
// Journal/Calculator/Capital unmounted Dashboard and silently killed the polling timer
// — turning Live back off with no warning (real user report: "live режим спадает при
// переключении на другие вкладки приложения"). Any page can now show the same Live
// toggle and see the same results (Journal's own Радар tab included).
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from './AuthContext';
import { getRadarItems } from '../services/radar';
import { fetchDailyCandles } from '../services/marketData/candles';
import { computeIndicatorsAtEntry } from '../services/analytics/indicators';
import { computePatternsAtEntry } from '../services/analytics/patterns';
import { computeMarketContextAtEntry } from '../services/analytics/marketContext';
import { evaluateStrategy } from '../services/analytics/strategy';

const RadarLiveContext = createContext(null);

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function RadarLiveProvider({ children }) {
  const { user, userProfile } = useAuth();
  const [radarLive, setRadarLive] = useState(false);
  const [radarUpdatedAt, setRadarUpdatedAt] = useState(null);
  const [radarResults, setRadarResults] = useState({}); // itemId -> { result, error }
  const prevPctRef = useRef({});

  // Turning the app account off, or the strategy being cleared, should turn Live off
  // too rather than keep silently polling with nothing meaningful to check.
  useEffect(() => {
    if (!user || !userProfile?.strategy?.conditions?.length) setRadarLive(false);
  }, [user, userProfile?.strategy]);

  useEffect(() => {
    if (!radarLive || !user || !userProfile?.strategy?.conditions?.length) return;
    let cancelled = false;

    const checkOne = async (item) => {
      try {
        const now = new Date();
        const candles = await fetchDailyCandles({
          ticker: item.ticker,
          instrumentType: item.instrumentType || 'stock',
          toDate: now,
          tinkoffToken: userProfile?.tinkoffToken,
          timeframe: item.timeframe || undefined,
        });
        const indicators = computeIndicatorsAtEntry(candles, now);
        const patterns = computePatternsAtEntry(candles, now);
        const marketContext = computeMarketContextAtEntry(candles, now);
        if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
        const result = evaluateStrategy(userProfile.strategy, { indicators, patterns, marketContext, plan: {} });
        return { result, error: null };
      } catch (e) {
        return { result: null, error: e.message || 'Не удалось загрузить данные' };
      }
    };

    const pollAll = async (isBaseline) => {
      const items = await getRadarItems(user.uid);
      for (const item of items) {
        if (cancelled) return;
        const { result, error } = await checkOne(item);
        setRadarResults((s) => ({ ...s, [item.id]: { result, error } }));
        if (!result?.total) continue;
        const pct = Math.round((result.passed / result.total) * 100);
        const threshold = userProfile?.strategy?.readinessThreshold ?? 100;
        const prev = prevPctRef.current[item.id];
        // Notify only on the crossing itself, not every poll a ticker stays ready —
        // and the first poll of a session just records the baseline silently, so
        // turning Live on doesn't instantly fire for tickers that were already ready.
        if (!isBaseline && prev != null && prev < threshold && pct >= threshold) {
          toast.success(`📡 ${item.ticker}: условия стратегии сошлись — ${result.passed} из ${result.total} (${pct}%)`, { duration: 10000 });
        }
        prevPctRef.current[item.id] = pct;
      }
      if (!cancelled) setRadarUpdatedAt(new Date());
    };

    pollAll(true);
    const interval = setInterval(() => pollAll(false), POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [radarLive, user, userProfile]);

  return (
    <RadarLiveContext.Provider value={{ radarLive, setRadarLive, radarUpdatedAt, radarResults }}>
      {children}
    </RadarLiveContext.Provider>
  );
}

export function useRadarLive() {
  return useContext(RadarLiveContext);
}
