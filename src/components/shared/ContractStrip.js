// src/components/shared/ContractStrip.js
//
// Узкая строка про фьючерс — «что за контракт, какое плечо, сколько можно купить на мои деньги»: показывается у инструмента ДО сделки
// (Сопровождение, открытое из радара). Плечо — главное число (без округления), ГО — вторым; числа — ГО Т-Банка, а без токена в Настройках — биржи, с подписью; «на ваши деньги» — отдельно для
// лонга и шорта по ГО своей стороны и лимиту доли депозита под ГО. Формулы — services/leverageMath.js и marketData/marginTrack.js.
import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { marginView, ruGo } from '../../services/marketData/marginTrack';
import { capacityByDirection, leverageText, capacityLine } from '../../services/leverageMath';
import useFuturesMargin from './useFuturesMargin';

export default function ContractStrip({ ticker, deposit, maxMarginPercent = 30 }) {
  const { user, userProfile } = useAuth();
  const { table, state, broker } = useFuturesMargin(true, user?.uid, { token: userProfile?.tinkoffToken, tickers: [ticker] });
  const mv = table ? marginView({ ticker, table, state, broker }) : null;
  if (!mv) return null;
  const cap = capacityByDirection({ deposit, maxMarginPercent, marginBuy: mv.buy, marginSell: mv.sell, valueRub: mv.value });
  const two = Math.abs(mv.buy - mv.sell) >= 0.005;
  const lb = leverageText(mv.levBuy), ls = leverageText(mv.levSell);
  return (
    <div className="ck-contract-strip" data-testid="ck-contract-strip">
      <span className="ck-cs-main">
        {mv.secid}{mv.viaRoot ? ` (ближайший по «${mv.viaRoot}»)` : ''}
        {lb && <> · плечо <b>{two && ls && ls !== lb ? `${lb} / ${ls}` : lb}</b></>}
        {' '}· ГО {two ? `лонг ${ruGo(mv.buy)} / шорт ${ruGo(mv.sell)}` : ruGo(mv.buy)} ₽
        <span className="ck-cs-src"> ({mv.src === 'tbank' ? 'Т-Банк' : 'биржа'})</span>
      </span>
      {cap && <span className="ck-cs-cap">На ваши деньги: {capacityLine(cap)}</span>}
      {mv.daysLeft != null && mv.daysLeft <= 10 && <span className="ck-cs-warn">до конца торгов контрактом {mv.daysLeft} дн.</span>}
    </div>
  );
}
