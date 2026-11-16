// src/components/cockpit/TrialTradeView.js
//
// Пробная сделка («Вошёл пробно» по сигналу системы) — ведётся здесь, в Сопровождении, как торговля вместе с роботом
// (решение владельца, 2026-11-17). Денег нет: объём условный, результат — в R и в учебных рублях (риск × R).
// Исполнение и стоп — по тем же правилам, что «Живые цены» в Тренажёре (services/trainer/liveSim.js): заявка
// исполняется по открытию следующей свечи, стоп и цель проверяются по закрытым свечам.
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import CandleChart from '../shared/CandleChart';
import { TIMEFRAMES } from '../../services/marketData/candles';
import { unrealized } from '../../services/trainer/trainerSim';
import { moveLiveStop, closeLive } from '../../services/trainer/liveSim';
import { latestLiveStop } from '../../services/trainer/liveCandles';

const px = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }));
const rr = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2).replace('.', ',')}R`);
const rub = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`);
const when = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const STATUS = { pending: 'ждёт исполнения', open: 'открыта', closed: 'закрыта', cancelled: 'отменена' };
const REASON = { stop: 'по стопу', take: 'по цели', manual: 'вручную' };

export default function TrialTradeView({ trial, candles, onSave, onRefresh, refreshing, signal, chartHeight = 460, panelRight = true }) {
  const [stopDraft, setStopDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const last = candles?.length ? candles[candles.length - 1] : null;
  const stop = latestLiveStop(trial);
  const upl = trial.status === 'open' && last ? unrealized({ ...trial, stopPrice: stop }, last.close) : null;
  const tfLabel = TIMEFRAMES[trial.timeframe]?.label || trial.timeframe;
  const isLong = trial.side === 'long';

  const persist = async (doc, message) => {
    setBusy(true);
    try {
      const { id, createdAt, updatedAt, ...body } = doc;
      await onSave(trial.id, body);
      toast.success(message);
      setStopDraft(null);
    } catch (e) {
      toast.error(e.message || 'Не удалось сохранить');
    }
    setBusy(false);
  };
  const saveStop = () => {
    const v = parseFloat(String(stopDraft).replace(',', '.'));
    if (!(v > 0)) { toast.error('Укажите цену стопа'); return; }
    if (!last) { toast.error('Нет свежей цены'); return; }
    try {
      const doc = moveLiveStop({ ...trial, stopPrice: stop }, v, Date.now(), last.close);
      persist(doc, `Стоп перенесён на ${px(v)}: действует со следующей свечи`);
    } catch (e) { toast.error(e.message); }
  };
  const closeNow = () => {
    if (!last) { toast.error('Нет свежей цены'); return; }
    try { persist(closeLive({ ...trial, stopPrice: stop }, last), `Пробная сделка закрыта по ${px(last.close)}`); } catch (e) { toast.error(e.message); }
  };

  return (
    <div className={`ck-work ${panelRight ? 'has-order' : ''}`}>
      <div className="ck-work-main">
        <section className="ck-panel ck-head">
          <div className="ck-head-id">
            <span className="ck-head-ticker">{trial.ticker}</span>
            <span className={`ck-dir ${trial.side}`}>{isLong ? 'ЛОНГ' : 'ШОРТ'}</span>
            <span className="ck-tag-trial" style={{ marginLeft: 8 }}>пробная, без денег</span>
          </div>
          <div className="ck-line-sub">
            {signal ? `По сигналу стратегии «${trial.strategyName || 'без названия'}». ` : ''}
            Деньги не участвуют: результат — в R и в учебных рублях от риска {Math.round(trial.riskMoney || 0).toLocaleString('ru-RU')} ₽.
            С реальными сделками не складывается.
          </div>
        </section>
        <section className="ck-panel ck-chart">
          {candles?.length ? (
            <CandleChart
              candles={candles}
              ticker={trial.ticker}
              instrumentType={trial.instrumentType || 'stock'}
              timeframe={trial.timeframe}
              direction={trial.side}
              entryPrice={trial.status === 'open' || trial.status === 'closed' ? trial.entryPrice : null}
              exitPrice={trial.status === 'closed' ? trial.exitPrice : null}
              planLines={{ entry: trial.status === 'pending' ? trial.orderPrice : null, stop, take: trial.takePrice ?? trial.orderTake ?? null }}
              entryMarker={trial.entryDate ? { date: trial.entryDate, price: trial.entryPrice, direction: trial.side } : null}
              exitMarker={trial.status === 'closed' && trial.exitDate ? { date: trial.exitDate, price: trial.exitPrice } : null}
              height={chartHeight}
            />
          ) : <div className="ck-line-sub">{refreshing ? 'Загружаю свечи…' : 'Свечей пока нет'}</div>}
        </section>
      </div>

      <aside className="ck-order">
        <section className="ck-panel ck-order-card">
          <h3>Пробная сделка</h3>
          <div className="ck-order-sub">
            {STATUS[trial.status] || trial.status}{trial.status === 'closed' && trial.exitReason ? ` ${REASON[trial.exitReason] || ''}` : ''} · свечи {tfLabel}
          </div>
          <div className="ck-calc-grid">
            <div><span className="ck-k">{trial.status === 'pending' ? 'Заявка от' : 'Вход'}</span><b>{px(trial.status === 'pending' ? trial.orderPrice : trial.entryPrice)}</b></div>
            <div><span className="ck-k">Стоп</span><b className="down">{px(stop)}</b></div>
            <div><span className="ck-k">Цель</span><b>{px(trial.takePrice ?? trial.orderTake)}</b></div>
            {trial.status === 'open' && <div><span className="ck-k">Сейчас</span><b className={upl?.r >= 0 ? 'up' : 'down'}>{rr(upl?.r)} · {rub(upl?.pnlVirtual)}</b></div>}
            {trial.status === 'closed' && <div><span className="ck-k">Итог</span><b className={trial.r >= 0 ? 'up' : 'down'}>{rr(trial.r)} · {rub(trial.pnlVirtual)}</b></div>}
            {trial.status === 'cancelled' && <div><span className="ck-k">Причина</span><b>{trial.cancelReason || '—'}</b></div>}
          </div>

          {trial.status === 'open' && (
            <>
              <div className="ck-order-row">
                <span className="ck-k">Стоп</span>
                {stopDraft == null ? (
                  <button className="ck-btn" onClick={() => setStopDraft(String(stop ?? ''))} disabled={busy}>Перенести</button>
                ) : (
                  <>
                    <input className="ck-order-input" inputMode="decimal" autoFocus value={stopDraft} placeholder="цена"
                      onChange={(e) => setStopDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveStop(); if (e.key === 'Escape') setStopDraft(null); }} />
                    <button className="ck-btn ck-btn-primary" onClick={saveStop} disabled={busy}>Сохранить</button>
                    <button className="ck-btn" onClick={() => setStopDraft(null)}>Отмена</button>
                  </>
                )}
              </div>
              <button className="ck-btn ck-btn-primary" onClick={closeNow} disabled={busy || !last}>
                Закрыть по {px(last?.close)}
              </button>
            </>
          )}
          <div className="ck-order-hint" style={{ textAlign: 'left', maxWidth: 'none' }}>
            Исполнение — по открытию следующей свечи, стоп и цель — по закрытым свечам. Перенесённый стоп действует со
            следующей свечи. Данные биржи без подписки идут с задержкой около 15 минут.
          </div>
          <button className="ck-btn" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Обновляю…' : 'Обновить по свежим свечам'}</button>
          {trial.entryDate && <div className="ck-order-sub">Открыта {when(trial.entryDate)}{trial.exitDate ? ` · закрыта ${when(trial.exitDate)}` : ''}</div>}
        </section>
      </aside>
    </div>
  );
}
