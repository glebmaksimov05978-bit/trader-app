// src/components/trainer/LiveDesk.js
//
// «Живые цены»: бумажные сделки на настоящих текущих свечах. Заявка исполняется по открытию следующей свечи, а дальше сделка
// сама доходит до стопа или тейка по закрытым свечам — даже если страницу не открывали (дочитывается при следующем входе и раз в
// минуту, пока страница открыта). Логика — services/trainer/liveSim.js. Закрытые сделки идут в «Разбор» как учебные
// (dataMode: 'live'), в реальный журнал не попадают.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import CandleChart from '../shared/CandleChart';
import Icon from '../shared/Icon';
import { useAuth } from '../../context/AuthContext';
import { fetchDailyCandles, availableTimeframes, TIMEFRAMES } from '../../services/marketData/candles';
import { catalogEntry } from '../../services/marketData/instrumentCatalog';
import { getStrategies } from '../../services/analytics/strategy';
import { atrOf } from '../../services/chartDrawings';
import { unrealized } from '../../services/trainer/trainerSim';
import { createLiveOrder, advanceLive, moveLiveStop, closeLive } from '../../services/trainer/liveSim';
import { addTrainerTrade, updateTrainerTrade } from '../../services/trainer/trainerTrades';

const REFRESH_MS = 60000;
const num = (s) => { const n = parseFloat(String(s ?? '').replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : null; };
const fmtR = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2).replace('.', ',')}R`;
const fmtPrice = (x) => (x == null ? '—' : x.toLocaleString('ru-RU', { maximumFractionDigits: 4 }));
const fmtDate = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const keyOf = (d) => `${d.ticker}|${d.timeframe}`;
const latestStop = (d) => (d.stopSchedule?.length ? d.stopSchedule[d.stopSchedule.length - 1].price : d.stopPrice);
const EVENT_TEXT = { filled: 'исполнена по открытию свечи', stop: 'закрыта по стопу', take: 'закрыта по тейку', cancelled: 'отменена: свеча открылась за стопом' };

async function loadCandles({ ticker, instrumentType, timeframe, tinkoffToken, sinceMs }) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES.D1;
  const days = Math.max(tf.lookbackDays, sinceMs ? Math.ceil((Date.now() - sinceMs) / 86400000) + 10 : 0);
  return fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), tinkoffToken, timeframe, lookbackDays: days });
}

export default function LiveDesk({ trades, onChanged }) {
  const { user, userProfile } = useAuth();
  const strategies = useMemo(() => getStrategies(userProfile), [userProfile]);
  const token = userProfile?.tinkoffToken || null;
  const tfOptions = useMemo(() => availableTimeframes(!!token), [token]);

  const active = useMemo(() => (trades || []).filter((t) => t.dataMode === 'live' && (t.status === 'pending' || t.status === 'open')), [trades]);
  const activeKey = active.map((t) => `${t.id}:${t.status}`).join(',');

  // --- форма новой заявки ---
  const [ticker, setTicker] = useState('SBER');
  const [timeframe, setTimeframe] = useState('D1');
  const [strategyId, setStrategyId] = useState('');
  const [riskMoney, setRiskMoney] = useState('1000');
  const [orderStop, setOrderStop] = useState('');
  const [orderTake, setOrderTake] = useState('');
  const [form, setForm] = useState(null);           // { ticker, timeframe, instrumentType, candles }
  const [loading, setLoading] = useState(false);
  // --- ведение ---
  const [candlesMap, setCandlesMap] = useState({}); // `${ticker}|${tf}` → свечи
  const [selectedId, setSelectedId] = useState(null);
  const [newStop, setNewStop] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const running = useRef(false);
  const tradesRef = useRef(active);
  tradesRef.current = active;

  const selected = active.find((t) => t.id === selectedId) || null;
  const view = selected ? candlesMap[keyOf(selected)] : form?.candles;
  const last = view?.length ? view[view.length - 1] : null;
  const atr = useMemo(() => atrOf((view || []).slice(-60), 14), [view]);
  const upl = selected && selected.status === 'open' && last ? unrealized(selected, last.close) : null;

  // Дочитать все активные сделки по свежим свечам и записать изменения.
  const refresh = useCallback(async (silent = true) => {
    if (running.current) return;
    const docs = tradesRef.current;
    if (!docs.length) return;
    running.current = true;
    try {
      const groups = new Map();
      docs.forEach((d) => { if (!groups.has(keyOf(d))) groups.set(keyOf(d), []); groups.get(keyOf(d)).push(d); });
      const nextMap = {};
      let anyChange = false;
      for (const [k, list] of groups) {
        const first = list[0];
        const since = Math.min(...list.map((d) => new Date(d.orderBarTime).getTime()));
        let candles;
        try { candles = await loadCandles({ ticker: first.ticker, instrumentType: first.instrumentType, timeframe: first.timeframe, tinkoffToken: token, sinceMs: since }); }
        catch (e) { if (!silent) toast.error(`${first.ticker}: ${e?.message || 'не удалось загрузить свечи'}`); continue; }
        nextMap[k] = candles;
        for (const d of list) {
          const r = advanceLive(d, candles, Date.now());
          if (!r.changed) continue;
          const { id, createdAt, updatedAt, ...body } = r.doc;
          try { await updateTrainerTrade(id, body); anyChange = true; } catch { toast.error('Не удалось сохранить обновление сделки'); continue; }
          r.events.forEach((ev) => toast(`${d.ticker}: заявка ${EVENT_TEXT[ev] || ev}`));
        }
      }
      setCandlesMap((m) => ({ ...m, ...nextMap }));
      setRefreshedAt(new Date());
      if (anyChange) onChanged?.();
    } finally { running.current = false; }
  }, [token, onChanged]);

  // При открытии страницы и при появлении новых активных сделок — сразу; затем раз в минуту, пока вкладка видна.
  useEffect(() => {
    if (!activeKey) return undefined;
    refresh(true);
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(true); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [activeKey, refresh]);

  useEffect(() => { if (selectedId && !active.some((t) => t.id === selectedId)) setSelectedId(null); }, [active, selectedId]);

  async function loadForm() {
    const t = ticker.trim().toUpperCase();
    if (!t) { toast.error('Укажите тикер'); return; }
    setLoading(true);
    try {
      const info = catalogEntry(t);
      const instrumentType = info?.type || 'stock';
      const candles = await loadCandles({ ticker: t, instrumentType, timeframe, tinkoffToken: token });
      if (!candles?.length) throw new Error(`По ${t} нет свечей`);
      setForm({ ticker: t, timeframe, instrumentType, candles });
      setSelectedId(null); setOrderStop(''); setOrderTake('');
    } catch (e) { toast.error(e?.message || 'Не удалось загрузить график'); }
    setLoading(false);
  }

  function setAtrStop(mult, side) {
    if (!atr || !last) return;
    setOrderStop(String(Number((side === 'long' ? last.close - atr * mult : last.close + atr * mult).toFixed(4))));
  }

  async function place(side) {
    if (!form || !last) return;
    const tf = TIMEFRAMES[form.timeframe] || TIMEFRAMES.D1;
    const strat = strategies.find((s) => s.id === strategyId);
    let doc;
    try {
      doc = createLiveOrder({
        side, stop: num(orderStop) ?? 0, take: orderTake === '' ? null : num(orderTake), riskMoney: num(riskMoney) ?? 0,
        ticker: form.ticker, instrumentType: form.instrumentType, timeframe: form.timeframe, tfMinutes: tf.minutes,
        lastCandleDate: last.date, lastPrice: last.close, strategyId: strat?.id, strategyName: strat ? (strat.name || strat.id) : null,
      });
    } catch (e) { toast.error(e.message); return; }
    setBusy(true);
    try {
      const ref = await addTrainerTrade(user.uid, doc);
      toast.success('Заявка поставлена: исполнится по открытию следующей свечи');
      setCandlesMap((m) => ({ ...m, [`${form.ticker}|${form.timeframe}`]: form.candles }));
      await onChanged?.();
      setSelectedId(ref.id); setForm(null);
    } catch (e) {
      toast.error(e?.code === 'permission-denied' ? 'Нет прав на запись учебных сделок — правила базы не опубликованы' : `Не удалось поставить заявку: ${e?.message || 'ошибка'}`);
    }
    setBusy(false);
  }

  async function persist(updated) {
    const { id, createdAt, updatedAt, ...body } = updated;
    await updateTrainerTrade(id, body);
    await onChanged?.();
  }

  async function applyStop() {
    const v = num(newStop);
    if (v == null || !selected || !last) { toast.error('Укажите цену стопа'); return; }
    try { await persist(moveLiveStop(selected, v, Date.now(), last.close)); setNewStop(''); toast('Стоп передвинут: действует со свечей, которые начнутся после этого момента'); }
    catch (e) { toast.error(e.message); }
  }

  async function closeNow() {
    if (!selected || !last) return;
    try { await persist(closeLive(selected, last)); toast.success('Сделка закрыта по последней цене и попала в «Разбор»'); setSelectedId(null); }
    catch (e) { toast.error(e.message); }
  }

  async function cancelOrder() {
    if (!selected) return;
    try { await persist({ ...selected, status: 'cancelled', cancelReason: 'Снято вами' }); setSelectedId(null); } catch { toast.error('Не удалось снять заявку'); }
  }

  const planLines = selected
    ? (selected.status === 'open' ? { entry: selected.entryPrice, stop: latestStop(selected), take: selected.takePrice } : { stop: selected.orderStop, take: selected.orderTake })
    : undefined;
  const shown = (view || []).slice(-250);

  return (
    <div className="tr-grid">
      <div className="tr-main">
        <div className="card tr-chart-card">
          <div className="tr-chart-head">
            <b>{selected ? selected.ticker : form ? form.ticker : 'Живой график'}</b>
            <span className="badge badge-purple">Учебная сделка</span>
            <span className="tr-muted">{token ? 'Данные Т-Инвестиций' : 'Данные MOEX, задержка около 15 минут'}{refreshedAt ? ` · обновлено ${refreshedAt.toLocaleTimeString('ru-RU')}` : ''}</span>
          </div>
          {shown.length ? (
            <CandleChart candles={shown} ticker={selected?.ticker || form?.ticker || ''} timeframe={selected?.timeframe || form?.timeframe || 'D1'} height={360} planLines={planLines} />
          ) : (
            <p className="tr-muted" style={{ padding: '60px 10px', textAlign: 'center' }}>Загрузите график справа или выберите свою позицию ниже.</p>
          )}
        </div>

        <div className="card" data-tour="trainer-live-list">
          <h3 className="tr-side-title">Мои живые позиции</h3>
          {active.length === 0 ? (
            <p className="tr-muted">Пока нет. Загрузите график, поставьте заявку со стопом — дальше сделка идёт по настоящим свечам сама, даже когда страница закрыта. Закрытые сделки попадают в «Разбор».</p>
          ) : (
            <div className="tr-table">
              {active.map((t) => {
                const lastC = candlesMap[keyOf(t)]?.slice(-1)[0];
                const u = t.status === 'open' && lastC ? unrealized(t, lastC.close) : null;
                return (
                  <button type="button" key={t.id} className={`tr-liverow ${t.id === selectedId ? 'on' : ''}`} onClick={() => { setSelectedId(t.id); setForm(null); }}>
                    <span className="tr-tname">{t.ticker} · {t.timeframe}</span>
                    <span className="badge badge-blue">{t.status === 'pending' ? 'Ждёт следующей свечи' : 'Открыта'}</span>
                    <span className="tr-muted">{t.side === 'long' ? 'покупка' : 'продажа'}{t.status === 'open' ? ` · вход ${fmtPrice(t.entryPrice)}` : ` · стоп ${fmtPrice(t.orderStop)}`}</span>
                    {u && <b className={u.r >= 0 ? 'tr-pos' : 'tr-neg'}>{fmtR(u.r)}</b>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <aside className="tr-side">
        {selected ? (
          <div className="card" data-tour="trainer-live-position">
            <h3 className="tr-side-title">{selected.status === 'pending' ? 'Заявка ждёт' : 'Позиция'}: {selected.side === 'long' ? 'покупка' : 'продажа'} {selected.ticker}</h3>
            {selected.status === 'pending' ? (
              <>
                <p className="tr-muted">Исполнится по открытию первой свечи, которая начнётся после {fmtDate(selected.orderBarTime)}. Стоп {fmtPrice(selected.orderStop)}{selected.orderTake != null ? `, тейк ${fmtPrice(selected.orderTake)}` : ''}.</p>
                <button type="button" className="btn btn-secondary" onClick={cancelOrder}>Снять заявку</button>
              </>
            ) : (
              <>
                <div className="tr-kv"><span>Вход</span><b>{fmtPrice(selected.entryPrice)} · {fmtDate(selected.filledAt || selected.entryDate)}</b></div>
                <div className="tr-kv"><span>Стоп</span><b>{fmtPrice(latestStop(selected))}</b></div>
                <div className="tr-kv"><span>Тейк</span><b>{fmtPrice(selected.takePrice)}</b></div>
                <div className="tr-kv"><span>Сейчас</span><b className={upl && upl.r >= 0 ? 'tr-pos' : 'tr-neg'}>{upl ? fmtR(upl.r) : '—'}</b></div>
                <div className="tr-kv"><span>Лучший ход / худший</span><b>{fmtR(selected.mfeR || 0)} / −{(selected.maeR || 0).toFixed(2).replace('.', ',')}R</b></div>
                <div className="tr-kv"><span>Закрытых свечей в сделке</span><b>{selected.barsHeld || 0}</b></div>
                <p className="tr-note">Стоп и тейк проверяются по ЗАКРЫТЫМ свечам, поэтому результат приходит с задержкой до конца свечи. Передвинутый стоп действует со свечей, которые начнутся после передвижения.</p>
                <div className="input-group" style={{ marginTop: 10 }}>
                  <label className="input-label" htmlFor="tr-live-newstop">Передвинуть стоп</label>
                  <div className="tr-row">
                    <input id="tr-live-newstop" className="input" inputMode="decimal" value={newStop} onChange={(e) => setNewStop(e.target.value)} placeholder={fmtPrice(latestStop(selected))} />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={applyStop}>Передвинуть</button>
                  </div>
                </div>
                <button type="button" className="btn btn-danger" style={{ marginTop: 10 }} onClick={closeNow} disabled={!last}>Закрыть по {fmtPrice(last?.close)}</button>
              </>
            )}
          </div>
        ) : (
          <div className="card" data-tour="trainer-live-order">
            <h3 className="tr-side-title">Новая заявка</h3>
            <div className="tr-form" style={{ margin: '0 0 10px' }}>
              <div className="input-group">
                <label className="input-label" htmlFor="tr-live-ticker">Тикер</label>
                <input id="tr-live-ticker" className="input" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} />
              </div>
              <div className="input-group">
                <label className="input-label" htmlFor="tr-live-tf">Таймфрейм</label>
                <select id="tr-live-tf" className="input" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                  {tfOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>
              <button type="button" className="btn btn-secondary" onClick={loadForm} disabled={loading}>{loading ? 'Загружаю…' : 'Загрузить график'}</button>
            </div>
            {form && (
              <>
                <p className="tr-muted">Последняя цена: <b>{fmtPrice(last?.close)}</b>{atr ? <> · ATR(14) ≈ {fmtPrice(Number(atr.toFixed(4)))}</> : null}</p>
                <div className="input-group">
                  <label className="input-label" htmlFor="tr-live-stop">Стоп (цена) — обязателен</label>
                  <input id="tr-live-stop" className="input" inputMode="decimal" value={orderStop} onChange={(e) => setOrderStop(e.target.value)} />
                  {atr && (
                    <div className="tr-quick">
                      <span>Быстро:</span>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(1, 'long')}>лонг, 1 ATR</button>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(2, 'long')}>лонг, 2 ATR</button>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(1, 'short')}>шорт, 1 ATR</button>
                      <button type="button" className="tr-chip" onClick={() => setAtrStop(2, 'short')}>шорт, 2 ATR</button>
                    </div>
                  )}
                </div>
                <div className="input-group">
                  <label className="input-label" htmlFor="tr-live-take">Тейк (цена) — по желанию</label>
                  <input id="tr-live-take" className="input" inputMode="decimal" value={orderTake} onChange={(e) => setOrderTake(e.target.value)} />
                </div>
                <div className="input-group">
                  <label className="input-label" htmlFor="tr-live-risk">Риск на сделку, ₽ (условно)</label>
                  <input id="tr-live-risk" className="input" inputMode="decimal" value={riskMoney} onChange={(e) => setRiskMoney(e.target.value)} />
                </div>
                <div className="input-group">
                  <label className="input-label" htmlFor="tr-live-strat">Стратегия, которую проверяете</label>
                  <select id="tr-live-strat" className="input" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
                    <option value="">Без стратегии (просто практика)</option>
                    {strategies.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                  </select>
                </div>
                <div className="tr-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => place('long')}>Купить</button>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => place('short')}>Продать</button>
                </div>
                <p className="tr-note">Это бумажная сделка: настоящих денег и заявок брокеру нет. Исполнение — по открытию следующей свечи, комиссия 0,05 % с каждой стороны.</p>
              </>
            )}
          </div>
        )}
        <div className="card">
          <h3 className="tr-side-title"><Icon name="info" size={13} /> Как это работает</h3>
          <p className="tr-muted">Сделка живёт в базе и дочитывается по настоящим свечам при каждом открытии страницы и раз в минуту, пока она открыта. Отдельного робота здесь нет: если не заходить, результат появится, когда вы зайдёте.</p>
        </div>
      </aside>
    </div>
  );
}
