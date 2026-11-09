// src/components/report/TradeViewModal.js
//
// «Посмотреть сделку» из отчёта: график инструмента вокруг сделки — где был вход, где выход и фиксации, стоп и цель — и
// краткие факты. Подходит и для реальных, и для бумажных (закрытых) сделок. Свечи грузятся по нажатию, а не вместе со страницей.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import CandleChart from '../shared/CandleChart';
import Icon from '../shared/Icon';
import { fetchDailyCandles, availableTimeframes, recommendTimeframe } from '../../services/marketData/candles';
import { resolveOpenedAt, resolveClosedAt } from '../../services/tradeDates';
import { describeLegs } from '../../services/tradeLegs';
import { guessInstrumentType } from '../../services/import/instrumentResolver';
import { fmtMoney } from '../../services/report/exportReport';
import './ReportExport.css';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const px = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }));
const dateTime = (d) => (d instanceof Date && !Number.isNaN(d.getTime())
  ? d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export default function TradeViewModal({ item, userProfile, onClose }) {
  const trade = item?.raw || {};
  const hasToken = !!userProfile?.tinkoffToken;
  const openedAt = useMemo(() => resolveOpenedAt(trade), [trade]);
  const closedAt = useMemo(() => (item?.closed instanceof Date ? item.closed : resolveClosedAt(trade)), [item, trade]);
  const durationMin = openedAt && closedAt ? (closedAt.getTime() - openedAt.getTime()) / 60000 : null;
  const [picked, setPicked] = useState(null);
  const timeframe = picked || trade.entryTimeframe || userProfile?.preferredTimeframe || recommendTimeframe(durationMin, hasToken);
  const ticker = item?.ticker;
  const instrumentType = trade.instrumentType || guessInstrumentType(ticker || '');
  const [state, setState] = useState({ loading: true, candles: null, error: null });
  // Окно открывается почти во весь экран, а график занимает то, что осталось под шапкой и таблицей операций.
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const ops = useMemo(() => describeLegs(trade.legs), [trade]);

  useEffect(() => {
    let alive = true;
    setState({ loading: true, candles: null, error: null });
    (async () => {
      try {
        // немного свечей и после выхода — чтобы было видно, что было дальше; но не дальше «сейчас»
        const toDate = new Date(Math.min(Date.now(), (closedAt ? closedAt.getTime() : Date.now()) + 2 * 86400000));
        const candles = await fetchDailyCandles({ ticker, instrumentType, toDate, tinkoffToken: userProfile?.tinkoffToken, timeframe });
        if (!alive) return;
        if (!candles.length) throw new Error('По этому инструменту нет свечей за нужный период');
        setState({ loading: false, candles, error: null });
      } catch (e) {
        if (alive) setState({ loading: false, candles: null, error: e.message || 'Не удалось загрузить график' });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, timeframe]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!item) return null;
  const short = item.direction === 'short';
  const legs = trade.legs?.length ? trade.legs : null;
  const stop = num(trade.stopLoss), take = num(trade.takeProfit);
  const pnl = item.pnl;

  return createPortal(
    <div className="rx-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rx-modal wide tv-big" role="dialog" aria-modal="true" aria-label={`Сделка ${ticker}`}>
        <div className="rx-head">
          <div>
            <h2>{ticker} · {short ? 'шорт' : 'лонг'} <span className="tv-src">{item.src === 'paper' ? 'бумага' : 'реал'}</span></h2>
            <p>{[item.strategy, closedAt ? `закрыта ${dateTime(closedAt)}` : null].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="rx-x" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={18} /></button>
        </div>
        <div className="rx-body">
          <div className="tv-facts">
            <div><span>Средний вход</span><b>{px(num(trade.entryPrice))}</b></div>
            <div><span>Выход</span><b>{px(num(trade.exitPrice))}</b></div>
            <div><span>Стоп</span><b>{stop != null ? px(stop) : '—'}</b></div>
            <div><span>Цель</span><b>{take ? px(take) : '—'}</b></div>
            <div><span>Результат</span><b className={pnl >= 0 ? 'tv-up' : 'tv-down'}>{fmtMoney(pnl)}</b></div>
          </div>
          {state.loading && <p className="rx-note">Загружаю график…</p>}
          {state.error && <p className="rx-error">{state.error}</p>}
          {state.candles && (
            <CandleChart
              candles={state.candles}
              ticker={ticker}
              instrumentType={trade.instrumentType}
              direction={item.direction}
              legs={legs}
              entryPrice={num(trade.entryPrice)}
              exitPrice={num(trade.exitPrice)}
              planLines={{ entry: null, stop, take: take || null }}
              entryMarker={!legs && openedAt ? { date: openedAt, price: num(trade.entryPrice), direction: item.direction } : null}
              exitMarker={!legs && closedAt && num(trade.exitPrice) != null ? { date: closedAt, price: num(trade.exitPrice) } : null}
              timeframe={timeframe}
              timeframeOptions={availableTimeframes(hasToken)}
              onTimeframeChange={setPicked}
              height={Math.max(300, Math.min(760, vh - (ops.length ? 400 : 320)))}
            />
          )}
          {/* Те же метки, что на графике, но списком — как это шло по времени: вход, докупки, частичные фиксации, выход.
              В Сопровождении (пока сделка открыта) график и метки те же — там это смотрят «вживую», здесь — уже итог. */}
          {ops.length > 0 && (
            <div className="tv-ops">
              <div className="tv-ops-title">Операции по сделке</div>
              <table>
                <tbody>
                  {ops.map((o, i) => (
                    <tr key={i} className={`tv-op-${o.kind}`}>
                      <td>{o.date ? dateTime(o.date) : '—'}</td>
                      <td><b>{o.action}</b></td>
                      <td>{o.quantity.toLocaleString('ru-RU')} шт.</td>
                      <td>{px(o.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="rx-note">Открыта: {dateTime(openedAt)}. На графике: стрелка — вход, кружки — фиксации и выход, белая линия — средняя цена входа{stop != null || take ? ', пунктиры — стоп и цель' : ''}. Таймфрейм можно сменить над графиком, кнопка ⛶ — на весь экран.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
