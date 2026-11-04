// src/components/auth/LoginDevSwitcher.js
//
// ВРЕМЕННАЯ панель выбора фона и знака на странице входа (владелец сравнивает варианты
// вживую). Выбор запоминается в localStorage. Убрать вместе с лишними вариантами.
import React from 'react';
import { BG_VARIANTS } from './LoginBackground';
import { BRAND_VARIANTS } from '../shared/BrandMark';

function Row({ title, items, value, onChange }) {
  return (
    <div className="lds-row">
      <span className="lds-title">{title}</span>
      {items.map((it) => (
        <button key={it.id} type="button" className={`lds-btn ${value === it.id ? 'on' : ''}`} onClick={() => onChange(it.id)} title={it.hint}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default function LoginDevSwitcher({ bg, onBg, icon, onIcon }) {
  return (
    <div className="lds">
      <Row title="Фон" items={BG_VARIANTS} value={bg} onChange={onBg} />
      <Row title="Знак" items={BRAND_VARIANTS} value={icon} onChange={onIcon} />
    </div>
  );
}
