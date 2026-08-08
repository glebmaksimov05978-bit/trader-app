// src/components/shared/NumberInput.js
//
// Real bug fix: every numeric field in this app used to do
// `onChange={(e) => set(parseFloat(e.target.value) || 0)}` directly against a controlled
// <input>. That means every keystroke re-parses the WHOLE field and snaps back to 0 (or
// the old value) the instant the text isn't a complete valid number yet — which happens
// constantly while typing normally: a trailing decimal point ("2." while typing "2.5"),
// or a briefly empty field while selecting-all-and-retyping. The field visibly "fights"
// the trader on almost every keystroke (real user report: "тяжело поменять стоп/тейк,
// годы истории... остаются нули либо не то значение").
//
// Fix: keep what's ON SCREEN as local text state, independent from the parsed number sent
// upstream. Only push a number up once the text actually parses. Only correct the display
// back to the last valid value on blur, never mid-keystroke.
import React, { useState, useEffect, useRef } from 'react';

export default function NumberInput({ value, onChange, ...props }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const focused = useRef(false);

  // Sync from outside (e.g. strategy switched, cache restored) — but never while the
  // trader is actively typing, or their in-progress keystroke gets clobbered by the
  // parent's re-render of the last committed value.
  useEffect(() => {
    if (focused.current) return;
    setText(value == null ? '' : String(value));
  }, [value]);

  return (
    <input
      {...props}
      type="number"
      value={text}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // Mid-typing states ("", "-", ".", "-.", trailing ".") aren't complete numbers yet
        // — don't push anything upstream until they resolve into one, so the parent never
        // sees (and re-renders us with) a bogus 0.
        if (raw === '' || /^-?\.?$/.test(raw) || /\.$/.test(raw)) return;
        const num = parseFloat(raw);
        if (!Number.isNaN(num)) onChange(num);
      }}
      onBlur={(e) => {
        focused.current = false;
        const raw = e.target.value;
        const num = raw === '' ? NaN : parseFloat(raw);
        // Left genuinely empty/invalid on blur — snap back to the last known-good value
        // instead of leaving garbage or a silent 0 behind.
        setText(Number.isNaN(num) ? (value == null ? '' : String(value)) : String(num));
        if (Number.isNaN(num) && value != null) onChange(value);
      }}
    />
  );
}
