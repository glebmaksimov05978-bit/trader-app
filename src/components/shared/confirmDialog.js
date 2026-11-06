// src/components/shared/confirmDialog.js
//
// Подтверждение действия в стиле приложения вместо системного window.confirm (тот выглядит чужим и блокирует вкладку).
// Использование: if (await confirmDialog({ title: 'Удалить расписание?', text: '…' })) { … } — вернёт true/false.
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import './Dialogs.css';

export function ConfirmView({ title, text, confirmLabel, cancelLabel, danger, onResult }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus(); // по умолчанию в фокусе «Отмена»: случайный Enter ничего не удалит
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onResult(false); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onResult]);
  return createPortal(
    <div className="dlg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onResult(false); }}>
      <div className="dlg-modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {text && <p>{text}</p>}
        <div className="dlg-actions">
          <button type="button" className="btn btn-ghost" ref={cancelRef} onClick={() => onResult(false)}>{cancelLabel}</button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onResult(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Показать окно подтверждения; Promise<boolean> (закрытие по Esc или клику вне окна — false). */
export function confirmDialog({ title = 'Подтвердите действие', text = '', confirmLabel = 'Удалить', cancelLabel = 'Отмена', danger = true } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    root.render(<ConfirmView title={title} text={text} confirmLabel={confirmLabel} cancelLabel={cancelLabel} danger={danger} onResult={finish} />);
  });
}

export default confirmDialog;
