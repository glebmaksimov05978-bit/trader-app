// src/components/journal/TradeModal.js
import React, { useState, useEffect, useRef } from 'react';
import { formatCurrency } from '../../utils/calculator';
import './Journal.css';

// ─── Кастомный date-пикер ────────────────────────────────────────────────────
const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                   'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const DAYS_RU = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function CustomDatePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => value ? new Date(value + 'T12:00:00') : new Date());
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Обновлять вид при смене value снаружи
  useEffect(() => {
    if (value) setViewDate(new Date(value + 'T12:00:00'));
  }, [value]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay(); // 0=вс
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = (firstDay === 0 ? 6 : firstDay - 1);

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const selectedDate = value ? new Date(value + 'T12:00:00') : null;
  const isSelected = (d) => {
    if (!d || !selectedDate) return false;
    return selectedDate.getFullYear() === year &&
           selectedDate.getMonth() === month &&
           selectedDate.getDate() === d;
  };
  const isToday = (d) => {
    if (!d) return false;
    const t = new Date();
    return t.getFullYear() === year && t.getMonth() === month && t.getDate() === d;
  };

  const pad = (n) => String(n).padStart(2, '0');
  const select = (d) => {
    if (!d) return;
    onChange(`${year}-${pad(month + 1)}-${pad(d)}`);
    setOpen(false);
  };
  const goToday = () => {
    const t = new Date();
    const str = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
    onChange(str);
    setViewDate(t);
    setOpen(false);
  };

  const displayValue = value
    ? new Date(value + 'T12:00:00').toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' })
    : '';

  return (
    <div ref={ref} style={{ position:'relative' }}>
      {/* Trigger */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display:'flex', alignItems:'center', gap:8,
          background:'var(--bg-surface-2)',
          border:`1px solid ${open ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
          borderRadius:'var(--radius-sm)',
          padding:'10px 14px',
          cursor:'pointer',
          fontSize:14,
          color: displayValue ? 'var(--text-primary)' : 'var(--text-muted)',
          transition:'border-color 0.2s, box-shadow 0.2s',
          userSelect:'none',
          boxShadow: open ? '0 0 0 3px rgba(79,70,229,0.15)' : 'none',
          width:'100%',
        }}
      >
        <span style={{fontSize:15}}>📅</span>
        <span style={{flex:1}}>{displayValue || 'Выберите дату'}</span>
        <span style={{
          color:'var(--text-muted)', fontSize:11,
          transform: open ? 'rotate(180deg)' : 'none',
          transition:'transform 0.2s',
          display:'inline-block',
        }}>▾</span>
      </div>

      {/* Dropdown */}
      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:1000,
          background:'var(--bg-surface)',
          border:'1px solid var(--border-medium)',
          borderRadius:16,
          padding:'14px',
          boxShadow:'0 20px 50px rgba(0,0,0,0.5)',
          width:260,
          animation:'fadeIn 0.15s ease',
        }}
          onClick={e => e.stopPropagation()}
        >
          {/* Навигация по месяцу */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <button
              onClick={() => setViewDate(new Date(year, month - 1, 1))}
              style={{
                background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)',
                borderRadius:8, width:30, height:30, cursor:'pointer',
                color:'var(--text-secondary)', fontSize:16,
                display:'flex', alignItems:'center', justifyContent:'center',
              }}
            >‹</button>
            <span style={{ fontWeight:700, fontSize:13, color:'var(--text-primary)', letterSpacing:0.3 }}>
              {MONTHS_RU[month]} {year}
            </span>
            <button
              onClick={() => setViewDate(new Date(year, month + 1, 1))}
              style={{
                background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)',
                borderRadius:8, width:30, height:30, cursor:'pointer',
                color:'var(--text-secondary)', fontSize:16,
                display:'flex', alignItems:'center', justifyContent:'center',
              }}
            >›</button>
          </div>

          {/* Дни недели */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, marginBottom:6 }}>
            {DAYS_RU.map(d => (
              <div key={d} style={{
                textAlign:'center', fontSize:10, fontWeight:700,
                color:'var(--text-muted)', padding:'3px 0',
                letterSpacing:0.5,
              }}>{d}</div>
            ))}
          </div>

          {/* Ячейки дней */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:3 }}>
            {cells.map((d, i) => (
              <div
                key={i}
                onClick={() => d && select(d)}
                style={{
                  height:32, display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:13, borderRadius:8,
                  cursor: d ? 'pointer' : 'default',
                  fontWeight: isSelected(d) ? 700 : 400,
                  background: isSelected(d)
                    ? 'linear-gradient(135deg, #4f46e5, #7c3aed)'
                    : isToday(d) ? 'rgba(79,70,229,0.18)' : 'transparent',
                  color: isSelected(d) ? '#fff'
                    : isToday(d) ? 'var(--accent-primary)'
                    : d ? 'var(--text-primary)' : 'transparent',
                  boxShadow: isSelected(d) ? '0 2px 8px rgba(79,70,229,0.4)' : 'none',
                  transition:'background 0.12s, color 0.12s',
                }}
                onMouseEnter={e => {
                  if (d && !isSelected(d)) e.currentTarget.style.background = 'var(--bg-surface-3)';
                }}
                onMouseLeave={e => {
                  if (d && !isSelected(d)) e.currentTarget.style.background = isToday(d) ? 'rgba(79,70,229,0.18)' : 'transparent';
                }}
              >
                {d || ''}
              </div>
            ))}
          </div>

          {/* Сегодня */}
          <div style={{ marginTop:10, paddingTop:10, borderTop:'1px solid var(--border-subtle)', display:'flex', justifyContent:'flex-end' }}>
            <button
              onClick={goToday}
              style={{
                background:'transparent', border:'none', cursor:'pointer',
                fontSize:12, color:'var(--accent-primary)', fontWeight:600,
                fontFamily:'inherit', padding:'2px 6px', borderRadius:6,
              }}
            >Сегодня</button>
          </div>
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

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
        const ticks = Math.abs(exit - entry) / step;
        const direction = form.direction === 'long' ? (exit > entry ? 1 : -1) : (exit < entry ? 1 : -1);
        pnl = ticks * stepAmt * vol * direction;
      } else {
        pnl = form.direction === 'long' ? (exit - entry) * vol * lot : (entry - exit) * vol * lot;
      }

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
              <CustomDatePicker value={form.date} onChange={v => set('date', v)} />
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
