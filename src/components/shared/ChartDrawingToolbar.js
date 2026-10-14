// src/components/shared/ChartDrawingToolbar.js
//
// Панель инструментов рисования над графиком. Сама ничего не рисует — только выбор инструмента,
// цвета, «магнита» и действий над выбранным рисунком; рисует и хранит CandleChart.
import React from 'react';
import { PALETTE, TOOL_LABELS } from '../../services/chartDrawings';

// Значки — простые линии в духе остальных иконок приложения (stroke, без заливки).
const ICONS = {
  cursor: <path d="M5 4l12 6-5 1.5L10 17z" />,
  hline: <><path d="M3 12h18" /><path d="M7 9l-3 3 3 3" opacity=".0" /></>,
  vline: <path d="M12 3v18" />,
  trend: <><path d="M4 18L20 6" /><circle cx="4" cy="18" r="1.6" /><circle cx="20" cy="6" r="1.6" /></>,
  ray: <><path d="M4 17L21 8" /><circle cx="4" cy="17" r="1.6" /><path d="M17 6l4 2-2 4" /></>,
  rect: <rect x="5" y="7" width="14" height="10" rx="1" />,
  fib: <><path d="M4 5h16M4 10h16M4 15h16M4 20h16" /><path d="M20 5L4 20" opacity=".6" /></>,
  text: <><path d="M6 6h12" /><path d="M12 6v12" /><path d="M9 18h6" /></>,
  ruler: <><path d="M3 15L15 3l6 6L9 21z" /><path d="M7 11l2 2M10 8l2 2M13 5l2 2" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>,
  magnet: <><path d="M6 4v7a6 6 0 0 0 12 0V4" /><path d="M6 8h3M15 8h3" /></>,
};

function Svg({ name }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const TOOLS = ['cursor', 'hline', 'vline', 'trend', 'ray', 'rect', 'fib', 'text', 'ruler'];

export default function ChartDrawingToolbar({
  open, onToggle, tool, onTool, color, onColor, magnet, onMagnet, label, onLabel,
  hasSelected, onDeleteSelected, count, onClearAll, hint,
}) {
  return (
    <div className="cc-draw">
      <button type="button" className={`cc-draw-toggle ${open ? 'on' : ''}`} onClick={onToggle}>
        Рисование{count ? ` · ${count}` : ''} {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="cc-draw-panel">
          <div className="cc-draw-tools" role="toolbar" aria-label="Инструменты рисования">
            {TOOLS.map((t) => (
              <button
                key={t} type="button"
                className={`cc-draw-btn ${tool === t ? 'on' : ''}`}
                onClick={() => onTool(t)}
                title={t === 'cursor' ? 'Курсор: выбрать рисунок кликом' : TOOL_LABELS[t]}
                aria-label={t === 'cursor' ? 'Курсор' : TOOL_LABELS[t]}
              >
                <Svg name={t} />
              </button>
            ))}
            <span className="cc-draw-sep" />
            <button type="button" className={`cc-draw-btn ${magnet ? 'on' : ''}`} onClick={onMagnet}
              title="Магнит: прилипать к цене открытия, максимума, минимума и закрытия свечи" aria-label="Магнит">
              <Svg name="magnet" />
            </button>
            <span className="cc-draw-sep" />
            {PALETTE.map((c) => (
              <button key={c} type="button" className={`cc-draw-color ${color === c ? 'on' : ''}`} style={{ background: c }}
                onClick={() => onColor(c)} title="Цвет" aria-label={`Цвет ${c}`} />
            ))}
            <span className="cc-draw-sep" />
            <button type="button" className="cc-draw-btn" onClick={onDeleteSelected} disabled={!hasSelected}
              title="Удалить выбранный рисунок (Delete)" aria-label="Удалить выбранное">
              <Svg name="trash" />
            </button>
            <button type="button" className="cc-draw-clear" onClick={onClearAll} disabled={!count}
              title="Стереть все рисунки на этом графике">
              Очистить
            </button>
          </div>
          {tool === 'text' && (
            <input
              className="input cc-draw-label" value={label} onChange={(e) => onLabel(e.target.value)}
              placeholder="Текст метки — затем кликните по графику" maxLength={40}
            />
          )}
          {hint && <div className="cc-draw-hint">{hint}</div>}
        </div>
      )}
    </div>
  );
}
