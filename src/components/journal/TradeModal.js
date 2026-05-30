// src/components/journal/TradeModal.js
import React, { useState, useEffect } from 'react';
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
  rr: '',
};

export default function TradeModal({ trade, onSave, onClose }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (trade) {
      const d = trade.date?.seconds
        ? new Date(trade.date.seconds * 1000).toISOString().split('T')[0]
        : trade.date || '';
      setForm({
        ...EMPTY,
        ...trade,
        date: d,
        pnl: trade.pnl !== undefined ? String(trade.pnl) : '',
        entryPrice: trade.entryPrice !== undefined ? String(trade.entryPrice) : '',
        exitPrice: trade.exitPrice !== undefined ? String(trade.exitPrice) : '',
        volume: trade.volume !== undefined ? String(trade.volume) : '',
      });
    }
  }, [trade]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Auto-calculate PnL if entry, exit, volume are set
  useEffect(() => {
    if (form.entryPrice && form.exitPrice && form.volume && !trade?.pnl) {
      const entry = parseFloat(form.entryPrice);
      const exit = parseFloat(form.exitPrice);
      const vol = parseFloat(form.volume);
      if (!isNaN(entry) && !isNaN(exit) && !isNaN(vol)) {
        const pnl = form.direction === 'long'
          ? (exit - entry) * vol
          : (entry - exit) * vol;
        set('pnl', String(Math.round(pnl * 100) / 100));
      }
    }
  }, [form.entryPrice, form.exitPrice, form.volume, form.direction, trade]);

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
      rr: form.rr ? parseFloat(form.rr) : null,
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
          {/* Row 1 */}
          <div className="grid-3">
            <div className="input-group">
              <label className="input-label">Тикер *</label>
              <input className="input" value={form.ticker}
                onChange={e => set('ticker', e.target.value.toUpperCase())}
                placeholder="SRZ4" style={{textTransform:'uppercase'}} />
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

          {/* Direction */}
          <div className="input-group">
            <label className="input-label">Направление</label>
            <div className="tabs">
              <button className={`tab ${form.direction==='long'?'active':''}`} onClick={() => set('direction','long')}>📈 Лонг</button>
              <button className={`tab ${form.direction==='short'?'active':''}`} onClick={() => set('direction','short')}>📉 Шорт</button>
            </div>
          </div>

          {/* Prices */}
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

          {/* PnL & commission */}
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
                onChange={e => set('commission', e.target.value)} placeholder="0" />
            </div>
            <div className="input-group">
              <label className="input-label">R/R фактический</label>
              <input className="input" type="number" step="0.1" value={form.rr}
                onChange={e => set('rr', e.target.value)} placeholder="0" />
            </div>
          </div>

          {/* Setup & emotion */}
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

          {/* Notes */}
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
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving || !form.ticker || !form.entryPrice}
          >
            {saving ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
