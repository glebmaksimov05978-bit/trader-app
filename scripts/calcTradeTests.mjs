// Проверка расчёта объёма в Калькуляторе (npm run test:calc): риск, комиссия, ограничения.
import { calcTrade } from '../src/utils/calculator.js';
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
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки Калькулятора прошли ✓');
