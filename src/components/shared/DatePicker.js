// src/components/shared/DatePicker.js
//
// Выбор даты в стиле приложения. Системный календарь браузера (<input type="date">) не стилизуется — на компьютере он
// выглядит чужим, поэтому свой: поле, куда можно ввести дату руками (дд.мм.гггг), и выпадающий календарь (месяц, стрелки,
// «Сегодня», «Очистить»). Значение — строка «ГГГГ-ММ-ДД» (как у системного поля) или пустая строка.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './DatePicker.css';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const pad = (n) => String(n).padStart(2, '0');

export const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** «ГГГГ-ММ-ДД» → «дд.мм.гггг»; пусто/неверно → ''. */
export function ruOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** «дд.мм.гггг» (допускается «д.м.гггг», разделители . / -) → «ГГГГ-ММ-ДД» или null, если даты не существует. */
export function parseRu(text) {
  const m = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/.exec(text || '');
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return isoOf(y, mo - 1, d);
}

const todayIso = () => { const n = new Date(); return isoOf(n.getFullYear(), n.getMonth(), n.getDate()); };

/** Сетка месяца: 6 недель по 7 дней, с понедельника; дни соседних месяцев помечены outside. */
export function monthGrid(y, m) {
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Пн = 0
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(Date.UTC(y, m, 1 - lead + i));
    cells.push({ iso: isoOf(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()), day: dt.getUTCDate(), outside: dt.getUTCMonth() !== m });
  }
  return cells;
}

export default function DatePicker({ value = '', onChange, min, max, placeholder = 'дд.мм.гггг', ariaLabel = 'Дата', className = '' }) {
  const [text, setText] = useState(ruOf(value));
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayIso();
    return { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 };
  });
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  // значение извне (сброс, выбор в календаре) → текст в поле
  useEffect(() => { setText(ruOf(value)); }, [value]);

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = 288, h = 330;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight;
    setPos({ left, top: below ? r.bottom + 6 : Math.max(8, r.top - h - 6), width: w });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, view, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const onMove = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  const inRange = (iso) => !(min && iso < min) && !(max && iso > max);

  const onType = (e) => {
    const v = e.target.value;
    setText(v);
    if (v.trim() === '') { onChange?.(''); return; }
    const iso = parseRu(v);
    if (iso && inRange(iso)) { onChange?.(iso); setView({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1 }); }
  };
  // потеряли фокус с недописанной датой — возвращаем последнее верное значение
  const onBlur = () => { const iso = parseRu(text); if (!iso || !inRange(iso)) setText(ruOf(value)); };

  const pick = (iso) => { if (!inRange(iso)) return; onChange?.(iso); setText(ruOf(iso)); setOpen(false); };
  const shift = (delta) => setView((v) => { const d = new Date(Date.UTC(v.y, v.m + delta, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; });
  const openCal = () => {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : (max && max < todayIso() ? max : (min && min > todayIso() ? min : todayIso()));
    setView({ y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 });
    setOpen((o) => !o);
  };

  const today = todayIso();
  const cells = monthGrid(view.y, view.m);

  return (
    <span className={`dp ${className}`} ref={wrapRef}>
      <input
        type="text" inputMode="numeric" autoComplete="off" className="input dp-input" placeholder={placeholder}
        value={text} onChange={onType} onBlur={onBlur} aria-label={ariaLabel} maxLength={10}
      />
      <button type="button" className="dp-btn" onClick={openCal} aria-label="Открыть календарь" aria-expanded={open}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div className="dp-pop" ref={popRef} role="dialog" aria-label="Календарь" style={{ left: pos.left, top: pos.top, width: pos.width }}>
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => shift(-1)} aria-label="Предыдущий месяц">‹</button>
            <b>{MONTHS[view.m]} {view.y}</b>
            <button type="button" className="dp-nav" onClick={() => shift(1)} aria-label="Следующий месяц">›</button>
          </div>
          <div className="dp-grid dp-dow">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
          <div className="dp-grid">
            {cells.map((c) => (
              <button
                key={c.iso} type="button" data-date={c.iso} disabled={!inRange(c.iso)}
                className={`dp-day${c.outside ? ' out' : ''}${c.iso === today ? ' today' : ''}${c.iso === value ? ' sel' : ''}`}
                onClick={() => pick(c.iso)}
              >{c.day}</button>
            ))}
          </div>
          <div className="dp-foot">
            <button type="button" className="dp-link" onClick={() => { onChange?.(''); setText(''); setOpen(false); }}>Очистить</button>
            <button type="button" className="dp-link" disabled={!inRange(today)} onClick={() => pick(today)}>Сегодня</button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
