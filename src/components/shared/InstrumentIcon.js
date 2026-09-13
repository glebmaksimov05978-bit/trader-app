// src/components/shared/InstrumentIcon.js
//
// Иконка инструмента — официальный логотип Т-Банка, если он уже узнан (см.
// services/marketData/instrumentLogos.js), иначе аккуратный кружок с буквами тикера.
// Один компонент на всё приложение, чтобы вид не расходился по экранам.
//
// Логотипа может не быть по трём причинам разом, и все три — нормальное состояние, не
// ошибка: инструмент ещё никто не открывал через Т-Банк, у трейдера вообще нет токена,
// или путь к картинке (LOGO_CDN) не подтверждён официально и мог не сработать. Поэтому
// заглушка — не временная штука на случай сбоя, а полноправный постоянный вид иконки.
import React, { useState } from 'react';

// Свой цвет на тикер, но всегда ОДИН И ТОТ ЖЕ при каждом показе — иначе один и тот же
// SBER мигал бы разными кружками в разных списках.
function colorFor(ticker) {
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) hash = (hash * 31 + ticker.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

export default function InstrumentIcon({ ticker, logoUrl, size = 24 }) {
  const [broken, setBroken] = useState(false);
  const t = (ticker || '?').toUpperCase();

  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt={t}
        width={size}
        height={size}
        style={{ borderRadius: '50%', flex: 'none', objectFit: 'cover', background: 'var(--bg-surface-2)' }}
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <span
      title={t}
      style={{
        width: size, height: size, borderRadius: '50%', flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: colorFor(t), color: '#fff', fontWeight: 700,
        fontSize: Math.max(9, Math.round(size * 0.4)), lineHeight: 1,
      }}
    >
      {t.slice(0, 2)}
    </span>
  );
}
