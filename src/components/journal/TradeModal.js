// src/components/journal/TradeModal.js
import React, { useState, useEffect } from 'react';
import { formatCurrency } from '../../utils/calculator';
import './Journal.css';

const EMPTY = {
  ticker: '',
  direction: 'long',
  date: new Date().toISOString().split('T')[0],
  entryPrice: '',
  exitPrice: '',
  volume: '',
  pnl: '',
  commission: '',
  status: 'closed',
  notes: '',
  setup: '',
  emotion: '',
  minStep: '',
  minStepAmount: '',
  lot: '1',
  commissionRate: '0.0006',
  depositSize: '100000',
};

export default function TradeModal({ trade, onSave, onClose, defaultDeposit }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [autoPnl, setAutoPnl] = useState(null);

  useEffect(() => {
    if (trade) {
      const d = trade.date?.seconds
        ? new Date(trade.date.seconds * 1000).toISOString().split('T')[0]
        : trade.date || '';
      setForm({
        ...EMPTY,
        ...trade,
        date: d,
        pnl: trade.pnl !== undefined && trade.pnl !== null ? String(trade.pnl) : '',
        entryPrice: trade.entryPrice !== undefined ? String(trade.entryPrice) : '',
        exitPrice: trade.exitPrice !== undefined && trade.exitPrice !== null ? String(trade.exitPrice) : '',
        volume: trade.volume !== undefined && trade.volume !== null ? String(trade.volume) : '',
        minStep: trade.minStep ? String(trade.minStep) : '',
        minStepAmount: trade.minStepAmount ? String(trade.minStepAmount) : '',
        lot: trade.lot ? String(trade.lot) : '1',
        commissionRate: trade.commissionRate ? String(trade.commissionRate) : '0.0006',
        depositSize: trade.depositSize ? String(trade.depositSize) : String(defaultDeposit || 100000),
      });
    } else {
      setForm(f => ({ ...f, depositSize: String(defaultDeposit || 100000) }));
    }
  }, [trade, defaultDeposit]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Auto-calculate PnL when exit price is entered
  useEffect(() => {
    const entry = parseFloat(form.entryPrice);
    const exit = parseFloat(form.exitPrice);
    const vol = parseFloat(form.volume);
    const step = parseFloat(form.minStep);
    const stepAmt = parseFloat(form.minStepAmount);
    const lot = parseFloat(form.lot) || 1;
    const commRate = parseFloat(form.commissionRate) || 0.0006;

    if (entry && exit && vol) {
      let pnl;
      if (step && stepAmt) {
        // Proper futures calculation
        const ticks = Math.abs(exit - entry) / step;
        const direction = form.direction === 'long' ? (exit > entry ? 1 : -1) : (exit < entry ? 1 : -1);
        pnl = ticks * stepAmt * vol * direction;
      } else {
        // Fallback
        pnl = form.direction === 'long' ? (exit - entry) * vol * lot : (entry - exit) * vol * lot;
      }

      // Commission
      const commission = entry * vol * lot * commRate * 2;
      const netPnl = pnl - commission;

      setAutoPnl({ pnl: Math.round(netPnl * 100) / 100, commission: Math.round(commission * 100) / 100 });
      set('pnl', String(Math.round(netPnl * 100) / 100));
      set('commission', String(Math.round(commission * 100) / 100));
    } else {
      setAutoPnl(null);
    }
  }, [form.exitPrice, form.entryPrice, form.volume, form.direction, form.minStep, form.minStepAmount, form.lot, form.commissionRate]);

  const deposit = parseFloat(form.depositSize) || 100000;
  const pnlVal = parseFloat(form.pnl) || 0;
  const pnlPercent = deposit > 0 ? ((pnlVal / deposit) * 100).toFixed(2) : 0;

  const handleSubmit = async () => {
    if (!form.ticker || !form.entryPrice) return;
    setSaving(true);
    const data = {
      ticker: form.ticker.toUpperCase(),
      direction: form.direction,
      date: form.date,
      entryPrice: parseFloat(form.entryPrice) || 0,
      exitPrice: form.exitPrice ? parseFloat(form.exitPrice) : null,
      volume: form.volume ? parseFloat(form.volume) : null,
      pnl: form.pnl !== '' ? parseFloat(form.pnl) : null,
      commission: form.commission ? parseFloat(form.commission) : null,
      status: form.status,
      notes: form.notes,
      setup: form.setup,
      emotion: form.emotion,
      minStep: form.minStep ? parseFloat(form.minStep) : null,
      minStepAmount: form.minStepAmount ? parseFloat(form.minStepAmount) : null,
      lot: parseFloat(form.lot) || 1,
      commissionRate: parseFloat(form.commissionRate) || 0.0006,
      depositSize: deposit,
      pnlPercent: form.pnl !== '' ? parseFloat(pnlPercent) : null,
    };
    await onSave(data);
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{trade ? 'Редактировать сделку' : 'Новая сделка'}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="grid-3">
            <div className="input-group">
              <label className="input-label">Тикер *</label>
              <input className="input" value={form.ticker}
                onChange={e => set('ticker', e.target.value.toUpperCase())}
                placeholder="SRZ6" style={{textTransform:'uppercase'}} />
            </div>
            <div className="input-group">
              <label className="input-label">Дата *</label>
              <input className="input" type="date" value={form.date}
                onChange={e => set('date', e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">Статус</label>
              <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="open">Открыта</option>
                <option value="closed">Закрыта</option>
              </select>
            </div>
          </div>

          <div className="input-group">
            <label className="input-label">Направление</label>
            <div className="tabs">
              <button className={`tab ${form.direction==='long'?'active':''}`} onClick={() => set('direction','long')}>📈 Лонг</button>
              <button className={`tab ${form.direction==='short'?'active':''}`} onClick={() => set('direction','short')}>📉 Шорт</button>
            </div>
          </div>

          <div className="grid-3">
            <div className="input-group">
              <label className="input-label">Цена входа *</label>
              <input className="input" type="number" value={form.entryPrice}
                onChange={e => set('entryPrice', e.target.value)} placeholder="0" />
            </div>
            <div className="input-group">
              <label className="input-label">Цена выхода</label>
              <input className="input" type="number" value={form.exitPrice}
                onChange={e => set('exitPrice', e.target.value)} placeholder="0" />
            </div>
            <div className="input-group">
              <label className="input-label">Объём (конт.)</label>
              <input className="input" type="number" value={form.volume}
                onChange={e => set('volume', e.target.value)} placeholder="1" />
            </div>
          </div>

          {/* Auto-calc hint */}
          {autoPnl && (
            <div style={{padding:'10px 14px', background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.2)', borderRadius:12, fontSize:13}}>
              <span className="text-secondary">Автоподсчёт: </span>
              <span style={{color: autoPnl.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight:600}}>
                {autoPnl.pnl >= 0 ? '+' : ''}{formatCurrency(autoPnl.pnl)}
              </span>
              <span className="text-muted"> (комиссия {formatCurrency(autoPnl.commission)})</span>
            </div>
          )}

          <div className="grid-3">
            <div className="input-group">
              <label className="input-label">P&L (₽)</label>
              <input className="input" type="number" value={form.pnl}
                onChange={e => set('pnl', e.target.value)}
                style={{color: parseFloat(form.pnl) >= 0 ? 'var(--green)' : 'var(--red)'}}
                placeholder="авто" />
            </div>
            <div className="input-group">
              <label className="input-label">Комиссия (₽)</label>
              <input className="input" type="number" value={form.commission}
                onChange={e => set('commission', e.target.value)} placeholder="авто" />
            </div>
            <div className="input-group">
              <label className="input-label">% от депозита</label>
              <input className="input" value={form.pnl ? `${pnlPercent}%` : ''}
                readOnly style={{color: pnlVal >= 0 ? 'var(--green)' : 'var(--red)', background:'var(--bg-surface-3)'}} />
            </div>
          </div>

          <div className="grid-2">
            <div className="input-group">
              <label className="input-label">Сетап / стратегия</label>
              <input className="input" value={form.setup}
                onChange={e => set('setup', e.target.value)} placeholder="Пробой уровня..." />
            </div>
            <div className="input-group">
              <label className="input-label">Эмоциональное состояние</label>
              <select className="input" value={form.emotion} onChange={e => set('emotion', e.target.value)}>
                <option value="">— не указано —</option>
                <option value="calm">😌 Спокойный</option>
                <option value="confident">💪 Уверенный</option>
                <option value="anxious">😰 Тревожный</option>
                <option value="greedy">🤑 Жадный</option>
                <option value="fear">😨 Страх</option>
                <option value="fomo">🏃 FOMO</option>
              </select>
            </div>
          </div>

          <div className="input-group">
            <label className="input-label">Заметки / разбор</label>
            <textarea className="input" rows={3}
              value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder="Что получилось, что нет, что сделаю иначе..."
              style={{resize:'vertical'}}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSubmit}
            disabled={saving || !form.ticker || !form.entryPrice}>
            {saving ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
