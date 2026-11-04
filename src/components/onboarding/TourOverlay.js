// src/components/onboarding/TourOverlay.js
//
// Экран тура: затемнение с «окном» вокруг нужного элемента и карточка с текстом шага. Без библиотек.
// Элемент не нашёлся (экран изменился или раздел пуст) — шаг показывается по центру, тур не ломается.
// На узком экране карточка — нижняя панель. Клавиши: ← → листают, Esc пропускает.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './onboarding.css';

const PAD = 8;           // зазор между подсвеченным элементом и рамкой
const GAP = 14;          // зазор между рамкой и карточкой
const MARGIN = 12;       // отступ карточки от края экрана

function measure(el) {
  const r = el.getBoundingClientRect();
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

export default function TourOverlay({ tour, index, auto, onNext, onPrev, onSkip, onDisable, onAction }) {
  const step = tour.steps[index];
  const total = tour.steps.length;
  const last = index === total - 1;
  const [rect, setRect] = useState(null);
  const [pos, setPos] = useState(null);
  const popRef = useRef(null);
  const nextRef = useRef(null);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;

  // Ищем элемент шага: несколько попыток (страница могла ещё дорисовываться), затем следим за его положением.
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let scrolled = false;
    let timer = 0;
    const find = () => (step.target ? step.target() : null);
    const tick = () => {
      if (!alive) return;
      const el = find();
      if (el) {
        if (!scrolled) {
          scrolled = true;
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* старый браузер */ }
        }
        setRect(measure(el));
        timer = setTimeout(tick, 220);
      } else if (tries < 5 && step.target) {
        tries += 1;
        setRect(null);
        timer = setTimeout(tick, 250);
      } else {
        setRect(null);
        timer = setTimeout(tick, 700); // вдруг элемент появится позже
      }
    };
    setRect(null);
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [step]);

  // Положение карточки: под элементом, иначе над ним, иначе сбоку; всегда внутри экрана.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    if (narrow || !rect) { setPos(null); return; }
    const clampX = (x) => Math.min(Math.max(MARGIN, x), vw - w - MARGIN);
    const clampY = (y) => Math.min(Math.max(MARGIN, y), vh - h - MARGIN);
    const cx = rect.left + rect.width / 2 - w / 2;
    if (rect.top + rect.height + GAP + h <= vh - MARGIN) setPos({ top: rect.top + rect.height + GAP, left: clampX(cx) });
    else if (rect.top - GAP - h >= MARGIN) setPos({ top: rect.top - GAP - h, left: clampX(cx) });
    else if (rect.left + rect.width + GAP + w <= vw - MARGIN) setPos({ top: clampY(rect.top + rect.height / 2 - h / 2), left: rect.left + rect.width + GAP });
    else if (rect.left - GAP - w >= MARGIN) setPos({ top: clampY(rect.top + rect.height / 2 - h / 2), left: rect.left - GAP - w });
    else setPos({ top: clampY(vh / 2 - h / 2), left: clampX(vw / 2 - w / 2) });
  }, [rect, step, narrow]);

  // Клавиатура и фокус.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onSkip(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); }
      else if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onPrev(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onNext, onPrev, onSkip, index]);
  useEffect(() => { nextRef.current?.focus({ preventScroll: true }); }, [index]);

  const centered = !rect || narrow;
  const popStyle = narrow
    ? undefined
    : (rect && pos ? { top: pos.top, left: pos.left } : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' });
  const isModal = !step.target || !rect; // без подсветки — карточка по центру

  return createPortal(
    <div className="tour-root" role="presentation">
      <div className="tour-catch" onClick={(e) => e.stopPropagation()} />
      {rect && !narrow ? (
        <div className="tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div
        ref={popRef}
        className={`tour-pop ${narrow ? 'sheet' : ''} ${isModal && !narrow ? 'modal' : ''}`}
        style={popStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-live="polite"
      >
        <div className="tour-head">
          <span className="tour-count">{tour.title} · {index + 1} из {total}</span>
          <button type="button" className="tour-x" aria-label="Закрыть подсказки" onClick={onSkip}>✕</button>
        </div>
        <h3 id="tour-title" className="tour-title">{step.title}</h3>
        <div className="tour-text">
          {step.text.split('\n').map((line, i) => (line.trim() === '' ? <div key={i} className="tour-gap" /> : <p key={i}>{line}</p>))}
        </div>
        <div className="tour-dots" aria-hidden="true">
          {tour.steps.map((s, i) => <i key={s.id} className={i === index ? 'on' : i < index ? 'past' : ''} />)}
        </div>
        <div className="tour-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSkip}>Пропустить</button>
          <div className="tour-nav">
            {index > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={onPrev}>Назад</button>}
            {last && step.action
              ? <button ref={nextRef} type="button" className="btn btn-primary btn-sm" onClick={() => onAction(step.action.to)}>{step.action.label}</button>
              : <button ref={nextRef} type="button" className="btn btn-primary btn-sm" onClick={onNext}>{last ? 'Готово' : 'Далее'}</button>}
          </div>
        </div>
        {auto && index === 0 && (
          <button type="button" className="tour-off" onClick={onDisable}>Больше не показывать подсказки</button>
        )}
      </div>
    </div>,
    document.body,
  );
}
