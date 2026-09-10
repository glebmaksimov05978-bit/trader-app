// src/components/cockpit/CollapsibleSection.js
//
// Общая раскладка для боковых блоков «Сопровождения» (позиции / лесенка / радар).
// Раньше радар сворачивался в отдельную узкую панель, но сама колонка грид-сетки
// оставалась прежней ширины — сворачивалось только содержимое, место оставалось
// пустым. Здесь колонка всегда одной ширины, а сворачивается именно контент внутри
// секции — поэтому места реально освобождается, а не просто прячется текст.
import React, { useState } from 'react';

export default function CollapsibleSection({ title, badge, actions, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ck-panel ck-section">
      <div className="ck-section-head">
        <button className="ck-section-toggle" onClick={() => setOpen((o) => !o)}>
          <span className={`ck-section-chevron ${open ? 'open' : ''}`}>›</span>
          <h3>{title}</h3>
          {badge != null && <span className="ck-cnt">{badge}</span>}
        </button>
        {actions && <div className="ck-section-actions" onClick={(e) => e.stopPropagation()}>{actions}</div>}
      </div>
      {open && <div className="ck-section-body">{children}</div>}
    </div>
  );
}
