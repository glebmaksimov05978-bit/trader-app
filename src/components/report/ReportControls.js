// src/components/report/ReportControls.js
//
// Элементы управления страницы «Отчёт»: переключатель периода и фильтр стратегий.
// Раньше период выбирался обычным выпадающим списком браузера — он выбивался из стиля приложения.
import React, { useEffect, useRef, useState } from 'react';

const MONTHS_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

function Chevron({ dir = 'down' }) {
  const d = dir === 'left' ? 'M10 3.5 5.5 8l4.5 4.5' : dir === 'right' ? 'M6 3.5 10.5 8 6 12.5' : 'M3.5 6 8 10.5 12.5 6';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Переключатель периода: стрелки к соседним периодам и окно со всеми, где есть данные.
 * @param {Array<{key:string,label:string}>} periods — от свежего к старому
 * @param {string} value — выбранный ключ ('YYYY-MM' или 'YYYY')
 * @param {'month'|'year'} type
 */
export function PeriodSwitcher({ periods, value, onChange, type }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const idx = periods.findIndex((p) => p.key === value);
  const current = idx >= 0 ? periods[idx] : null;
  const older = idx >= 0 ? periods[idx + 1] : null;
  const newer = idx > 0 ? periods[idx - 1] : null;
  const has = new Set(periods.map((p) => p.key));
  const pick = (key) => { onChange(key); setOpen(false); };

  // Годы, которые показать в окне месяцев: от самого свежего до самого старого с данными.
  const years = type === 'month' && periods.length
    ? (() => {
      const ys = periods.map((p) => Number(p.key.slice(0, 4)));
      const out = [];
      for (let y = Math.max(...ys); y >= Math.min(...ys); y--) out.push(y);
      return out;
    })()
    : [];

  return (
    <div className="mr-period" ref={box}>
      <button type="button" className="mr-period-arrow" aria-label="Более ранний период" disabled={!older} onClick={() => older && onChange(older.key)}>
        <Chevron dir="left" />
      </button>
      <button type="button" className="mr-period-label" aria-haspopup="listbox" aria-expanded={open} disabled={!periods.length} onClick={() => setOpen((o) => !o)}>
        <span>{current ? current.label : 'Нет данных'}</span>
        <Chevron dir="down" />
      </button>
      <button type="button" className="mr-period-arrow" aria-label="Более поздний период" disabled={!newer} onClick={() => newer && onChange(newer.key)}>
        <Chevron dir="right" />
      </button>

      {open && (
        <div className="mr-period-pop" role="listbox">
          {type === 'year' ? (
            <div className="mr-pop-years">
              {periods.map((p) => (
                <button key={p.key} type="button" role="option" aria-selected={p.key === value} className={`mr-pop-cell ${p.key === value ? 'on' : ''}`} onClick={() => pick(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
          ) : (
            years.map((y) => (
              <div key={y} className="mr-pop-year">
                <div className="mr-pop-year-title">{y}</div>
                <div className="mr-pop-months">
                  {MONTHS_SHORT.map((m, i) => {
                    const key = `${y}-${String(i + 1).padStart(2, '0')}`;
                    const ok = has.has(key);
                    return (
                      <button key={key} type="button" role="option" aria-selected={key === value} disabled={!ok} className={`mr-pop-cell ${key === value ? 'on' : ''}`} onClick={() => pick(key)}>
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Фильтр стратегий: «Все» или одна/несколько отмеченных. Пустой выбор = все.
 * Показывается, только если стратегий в данных две и больше.
 * @param {Array<{name:string,count:number}>} names
 * @param {string[]} selected
 */
export function StrategyFilter({ names, selected, onChange }) {
  if (!names || names.length < 2) return null;
  const all = selected.length === 0 || selected.length >= names.length;
  const toggle = (name) => {
    const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
    // Отмечены все — это то же самое, что «Все».
    onChange(next.length >= names.length ? [] : next);
  };
  return (
    <div className="mr-filter" role="group" aria-label="Стратегии">
      <span className="mr-filter-label">Стратегии</span>
      <button type="button" className={`mr-chip ${all ? 'on' : ''}`} aria-pressed={all} onClick={() => onChange([])}>Все</button>
      {names.map((n) => {
        const on = !all && selected.includes(n.name);
        return (
          <button key={n.name} type="button" className={`mr-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(n.name)}>
            {n.name}<span className="mr-chip-n">{n.count}</span>
          </button>
        );
      })}
    </div>
  );
}
