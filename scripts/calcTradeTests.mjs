// Проверка расчёта объёма в Калькуляторе (npm run test:calc): риск, комиссия, ограничения.
import { calcTrade, scaleToContracts } from '../src/utils/calculator.js';
import { parseBrokerFutureMargin, futuresLeverage } from '../src/services/marketData/brokerMargin.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// Акция: SBER 300, стоп 294, лот 10, риск 1% от 100 000 = 1000 ₽.
// Убыток на лот 6×10 = 60 ₽ + комиссия 300×10×0.05%×2 = 3 ₽ → 63 ₽ → по риску 15 лотов;
// ограничение позиции 30% депозита = 30 000 ₽ / 3000 ₽ за лот = 10 лотов.
const s = calcTrade({ entryPrice: 300, stopLoss: 294, takeProfit: 312, depositSize: 100000, riskPercent: 1, lot: 10, commissionRate: 0.0005, instrumentType: 'stock', maxMarginPercent: 30 });
ok('акция: по риску 15 лотов', s.contractsByRisk === 15);
ok('акция: итог 10 лотов (ограничение 30% депозита)', s.contracts === 10);
ok('акция: стоимость позиции 30 000 ₽', s.positionValue === 30000);
ok('акция: прибыль к риску 2', near(s.rr, 2));

// Фьючерс Brent: шорт 80 → стоп 81, шаг 0,01 = 7,5 ₽ (лот 10 уже внутри стоимости шага), ГО 9000.
// Убыток на контракт 100 шагов × 7,5 = 750 ₽; комиссия от стоимости контракта 80/0,01×7,5 = 60 000 ₽ × 0,04% × 2 = 48 ₽.
const f = calcTrade({ entryPrice: 80, stopLoss: 81, depositSize: 100000, riskPercent: 1, lot: 10, minStep: 0.01, minStepAmount: 7.5, initialMargin: 9000, commissionRate: 0.0004, instrumentType: 'future' });
ok('фьючерс: направление шорт', f.direction === 'short');
ok('фьючерс: 1000 ₽ / (750 + 48) = 1 контракт', f.contractsByRisk === 1 && f.contracts === 1);
ok('фьючерс: стоимость позиции в рублях 60 000 (а не 80 × лот)', f.positionValue === 60000);
ok('фьючерс: комиссия 48 ₽ за круг', Math.round(f.commission) === 48);

// Фьючерс без стоимости шага (мини-контракт): шаг × лот
const m = calcTrade({ entryPrice: 100, stopLoss: 99, depositSize: 100000, riskPercent: 1, lot: 10, minStep: 1, minStepAmount: 0, commissionRate: 0, instrumentType: 'future' });
ok('фьючерс без стоимости шага: 1 пункт × лот 10 = 10 ₽ на контракт → 100 контрактов', m.contractsByRisk === 100);

ok('без стопа — расчёта нет', calcTrade({ entryPrice: 100, stopLoss: 0, depositSize: 1000, riskPercent: 1 }) === null);

// --- ГО по стороне сделки (у Т-Банка ГО на покупку и на продажу разное) -------------------------
// Роснефть RNZ6 на 12.10.2026: лонг 7 438,81 ₽, шорт 9 454,51 ₽. Депозит 150 000, риск 5%, лимит ГО 30% = 45 000 ₽.
const rn = { depositSize: 150000, riskPercent: 5, minStep: 1, minStepAmount: 1, lot: 1, commissionRate: 0.0004, instrumentType: 'future', maxMarginPercent: 30, initialMarginBuy: 7438.81, initialMarginSell: 9454.51 };
const rnShort = calcTrade({ ...rn, entryPrice: 38830, stopLoss: 38900 });
const rnLong = calcTrade({ ...rn, entryPrice: 38830, stopLoss: 38760 });
ok('шорт: берётся ГО продажи, 45 000 / 9 454,51 → 4 контракта', rnShort.direction === 'short' && rnShort.contracts === 4 && rnShort.marginSide === 'short' && near(rnShort.marginPerContract, 9454.51, 0.01));
ok('лонг: берётся ГО покупки, 45 000 / 7 438,81 → 6 контрактов', rnLong.direction === 'long' && rnLong.contracts === 6 && rnLong.marginSide === 'long' && near(rnLong.marginPerContract, 7438.81, 0.01));
ok('шорт: ГО под 4 контракта не больше лимита 30% депозита', rnShort.totalMargin <= 45000);
ok('плечо = стоимость контракта / ГО (38 830 / 9 454,51 ≈ 4,1)', near(rnShort.leverage, 4.1, 0.05));
// Одно число «на обе стороны» (ручной ввод или биржа) — запасной вариант, как раньше.
const one = calcTrade({ ...rn, initialMarginBuy: 0, initialMarginSell: 0, initialMargin: 8000, entryPrice: 38830, stopLoss: 38900 });
ok('без ГО по сторонам берётся общее число (8 000 → 5 контрактов), сторона «any»', one.contracts === 5 && one.marginSide === 'any');
const none = calcTrade({ ...rn, initialMarginBuy: 0, initialMarginSell: 0, entryPrice: 38830, stopLoss: 38900 });
ok('совсем без ГО ограничения по ГО нет, плечо не показывается', none.marginSide === 'none' && none.leverage === 0 && none.contracts === none.contractsByRisk);

// --- Безубыток -------------------------------------------------------------------------------
// Акция SBER 300, лот 10, комиссия 0,05% за сторону → круг на лот 3 ₽ = 0,30 ₽ на акцию (раньше показывало 303).
const sb = calcTrade({ entryPrice: 300, stopLoss: 294, takeProfit: 312, depositSize: 1000000, riskPercent: 1, lot: 10, minStep: 0.01, commissionRate: 0.0005, instrumentType: 'stock', maxMarginPercent: 100 });
ok('акция с лотом 10: безубыток 300,3 (а не 303)', near(sb.breakeven, 300.3, 0.051));
// Brent: круг на контракт 48 ₽ / 7,5 ₽ за шаг = 6,4 шага × 0,01 → шорт безубыток 80 − 0,064 ≈ 79,9.
ok('фьючерс Brent: безубыток шорта ≈ 79,9', near(f.breakeven, 79.9, 0.051));

// --- Пересчёт на объём, введённый руками -------------------------------------------------------
// Brent, 3 контракта: рубли за пункт 7,5/0,01 = 750 → стоимость 80 × 3 × 750 = 180 000 ₽, комиссия 0,04% × 2 = 144 ₽ (раньше 0,06–0,64 ₽).
const bt = calcTrade({ entryPrice: 80, stopLoss: 81, takeProfit: 78, depositSize: 100000, riskPercent: 1, lot: 10, minStep: 0.01, minStepAmount: 7.5, initialMargin: 9000, commissionRate: 0.0004, instrumentType: 'future' });
const sc = scaleToContracts(bt, 3, { entryPrice: 80, commissionRate: 0.0004, depositSize: 100000, instrumentType: 'future' });
ok('ручной объём: стоимость позиции 180 000 ₽', sc.positionValue === 180000);
ok('ручной объём: комиссия 144 ₽', sc.commission === 144);
ok('ручной объём: ГО 3 × 9 000 = 27 000 ₽ = 27% депозита', sc.totalMargin === 27000 && sc.marginUsagePercent === 27);
ok('ручной объём: убыток = 3 × 750 + комиссия', sc.totalLoss === 3 * 750 + 144);
ok('ручной объём совпадает с расчётом при том же числе контрактов', scaleToContracts(bt, bt.contracts, { entryPrice: 80, commissionRate: 0.0004, depositSize: 100000, instrumentType: 'future' }).commission === bt.commission);

// --- Разбор ответа брокера (FutureBy) ----------------------------------------------------------
const brokerAnswer = {
  initialMarginOnBuy: { currency: 'rub', units: '7438', nano: 810000000 },
  initialMarginOnSell: { currency: 'rub', units: '9454', nano: 510000000 },
  dlongClient: { units: '0', nano: 250000000 }, dshortClient: { units: '0', nano: 300000000 },
  shortEnabledFlag: true, buyAvailableFlag: true, sellAvailableFlag: true,
};
const pm = parseBrokerFutureMargin(brokerAnswer);
ok('ответ брокера: ГО покупки и продажи разобраны', near(pm.initialMarginBuy, 7438.81, 0.001) && near(pm.initialMarginSell, 9454.51, 0.001));
ok('ответ брокера: ставки риска клиента и доступность шорта', pm.dlongClient === 0.25 && pm.dshortClient === 0.3 && pm.shortEnabled === true);
const oneSide = parseBrokerFutureMargin({ initialMarginOnBuy: { units: '5000', nano: 0 } });
ok('прислана только одна сторона — вторая берётся такой же', oneSide.initialMarginBuy === 5000 && oneSide.initialMarginSell === 5000);
ok('ГО в ответе нет — null, а не нули', parseBrokerFutureMargin({}) === null && parseBrokerFutureMargin(null) === null);
ok('плечо: 38 830 / 9 454,51 ≈ 4,1; без ГО — 0', near(futuresLeverage(38830, 9454.51), 4.107, 0.001) && futuresLeverage(38830, 0) === 0);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки Калькулятора прошли ✓');
