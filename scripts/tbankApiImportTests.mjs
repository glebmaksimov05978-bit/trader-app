// Проверка автоимпорта сделок из API Т-Банка (npm run test:apiimport): перевод операций в транзакции, определение
// единиц количества, комиссии, пропуски с причинами и сквозной путь через FIFO. Сеть не нужна; формы ответов —
// по официальному описанию контрактов API (GetOperationsByCursor), на живых данных не сверялись.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '../src/services/import');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-apiimport-'));
function esmify(name) {
  let t = fs.readFileSync(path.join(src, name), 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  const out = path.join(tmp, name);
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
const api = await import(esmify('tbankApiImport.js'));
esmify('instrumentResolver.js');
const { matchTransactionsToTrades } = await import(esmify('fifoMatcher.js'));

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const mv = (v) => ({ currency: 'rub', units: String(Math.trunc(v)), nano: Math.round((v - Math.trunc(v)) * 1e9) });
const op = (o) => ({
  id: 'op' + Math.random().toString(36).slice(2, 8), state: 'OPERATION_STATE_EXECUTED', instrumentType: 'share',
  classCode: 'TQBR', ...o,
});

// 1. Акция с лотом 10: 2 лота по 300 ₽ за акцию, сумма 6000 ₽ = 300 × 2 × 10 → количество в ЛОТАХ → 20 штук.
const buyLots = op({
  type: 'OPERATION_TYPE_BUY', ticker: 'SBER', date: '2026-10-01T10:00:00Z', quantity: '2', quantityRest: '0', price: mv(300),
  payment: mv(-6000), commission: mv(-3),
  tradesInfo: { trades: [{ num: 'T1', date: '2026-10-01T10:00:00Z', quantity: '1', price: mv(300) }, { num: 'T2', date: '2026-10-01T10:00:05Z', quantity: '1', price: mv(300) }] },
});
let r = api.tbankOperationsToTransactions([buyLots], { lotByTicker: { SBER: 10 } });
ok('акция в лотах: две сделки по 10 штук', r.transactions.length === 2 && r.transactions.every((t) => t.quantity === 10));
ok('акция в лотах: номера сделок из массива сделок', r.transactions.map((t) => t.dealNumber).join() === 'T1,T2');
ok('комиссия 3 ₽ поделена по сделкам: по 1,5', r.transactions.every((t) => near(t.commission, 1.5)));

// 2. Та же операция, но количество в ШТУКАХ (20): сумма = цена × 20 → фактор 1.
const buyUnits = op({
  type: 'OPERATION_TYPE_BUY', ticker: 'SBER', date: '2026-10-01T10:00:00Z', quantity: '20', quantityRest: '0', price: mv(300),
  payment: mv(-6000), commission: mv(-3),
  tradesInfo: { trades: [{ num: 'T9', date: '2026-10-01T10:00:00Z', quantity: '20', price: mv(300) }] },
});
r = api.tbankOperationsToTransactions([buyUnits], { lotByTicker: { SBER: 10 } });
ok('акция в штуках: 20 штук, а не 200', r.transactions.length === 1 && r.transactions[0].quantity === 20);

// 3. Единицы не определились (сумма не сходится ни так, ни так) или лотность неизвестна — пропуск с причиной, не догадка.
const weird = op({ type: 'OPERATION_TYPE_BUY', ticker: 'GAZP', date: '2026-10-01T10:00:00Z', quantity: '3', quantityRest: '0', price: mv(100), payment: mv(-777),
  tradesInfo: { trades: [{ num: 'W1', date: '2026-10-01T10:00:00Z', quantity: '3', price: mv(100) }] } });
r = api.tbankOperationsToTransactions([weird], { lotByTicker: { GAZP: 10 } });
ok('сумма не сходится — операция пропущена с причиной', r.transactions.length === 0 && r.skipped.length === 1 && /не сходится/.test(r.skipped[0].reason));
r = api.tbankOperationsToTransactions([buyLots], { lotByTicker: {} });
ok('лотность неизвестна — операция пропущена с причиной', r.transactions.length === 0 && /лотность/.test(r.skipped[0].reason));

// 4. Лот 1: единицы не проверяются, количество как есть.
const lot1 = op({ type: 'OPERATION_TYPE_SELL', ticker: 'LKOH', date: '2026-10-02T10:00:00Z', quantity: '5', quantityRest: '0', price: mv(7000), payment: mv(35000), commission: mv(-17.5),
  tradesInfo: { trades: [{ num: 'L1', date: '2026-10-02T10:00:00Z', quantity: '5', price: mv(7000) }] } });
r = api.tbankOperationsToTransactions([lot1], { lotByTicker: { LKOH: 1 } });
ok('лот 1: количество 5, сторона продажа', r.transactions[0].quantity === 5 && r.transactions[0].side === 'sell');

// 5. Фьючерс: контракты как есть, признак фьючерса, комиссия из дочерних операций, если своей нет.
const fut = op({
  type: 'OPERATION_TYPE_SELL', instrumentType: 'futures', ticker: 'SRZ6', classCode: 'SPBFUT', date: '2026-10-03T07:00:00Z', quantity: '2', quantityRest: '0', price: mv(29356),
  payment: mv(0), childOperations: [{ payment: mv(-5.5) }, { payment: mv(-0.5) }],
  tradesInfo: { trades: [{ num: 'F1', date: '2026-10-03T07:00:00Z', quantity: '2', price: mv(29356) }] },
});
r = api.tbankOperationsToTransactions([fut], {});
ok('фьючерс: 2 контракта, isFuture, цена как есть', r.transactions[0].quantity === 2 && r.transactions[0].isFuture === true && r.transactions[0].price === 29356);
ok('фьючерс: комиссия = сумма дочерних операций (6 ₽)', near(r.transactions[0].commission, 6));

// 6. Не сделки и неподдерживаемое: комиссии молча мимо, облигации — пропуск с причиной, неисполненные — мимо.
const fee = op({ type: 'OPERATION_TYPE_BROKER_FEE', date: '2026-10-03T07:00:00Z', payment: mv(-10) });
const bond = op({ type: 'OPERATION_TYPE_BUY', instrumentType: 'bond', ticker: 'SU26238RMFS4', date: '2026-10-03T07:00:00Z', quantity: '1', price: mv(950), payment: mv(-950) });
const pending = op({ type: 'OPERATION_TYPE_BUY', state: 'OPERATION_STATE_CANCELED', ticker: 'SBER', date: '2026-10-03T07:00:00Z', quantity: '1', price: mv(300) });
r = api.tbankOperationsToTransactions([fee, bond, pending], {});
ok('комиссия и отменённая заявка — не сделки, молча', r.transactions.length === 0 && r.skipped.length === 1);
ok('облигация — пропуск с причиной', /не поддерживается/.test(r.skipped[0].reason));

// 7. Сквозной путь: покупка 2 фьючерсов и продажа 2 → FIFO даёт одну закрытую позицию.
const buyF = op({ type: 'OPERATION_TYPE_BUY', instrumentType: 'futures', ticker: 'SRZ6', classCode: 'SPBFUT', date: '2026-10-03T07:00:00Z', quantity: '2', quantityRest: '0', price: mv(29000), payment: mv(0), commission: mv(-4),
  tradesInfo: { trades: [{ num: 'B1', date: '2026-10-03T07:00:00Z', quantity: '2', price: mv(29000) }] } });
const sellF = op({ type: 'OPERATION_TYPE_SELL', instrumentType: 'futures', ticker: 'SRZ6', classCode: 'SPBFUT', date: '2026-10-03T12:00:00Z', quantity: '2', quantityRest: '0', price: mv(29300), payment: mv(0), commission: mv(-4),
  tradesInfo: { trades: [{ num: 'S1', date: '2026-10-03T12:00:00Z', quantity: '1', price: mv(29300) }, { num: 'S2', date: '2026-10-03T12:00:10Z', quantity: '1', price: mv(29300) }] } });
r = api.tbankOperationsToTransactions([sellF, buyF], {});
ok('транзакции отсортированы по времени', r.transactions[0].dealNumber === 'B1');
const m = matchTransactionsToTrades(r.transactions, []);
ok('FIFO: одна закрытая лонг-позиция на 2 контракта', m.matched.length === 1 && m.matched[0].status === 'closed' && m.matched[0].direction === 'long' && m.matched[0].volume === 2);
ok('FIFO: вход 29000, выход 29300, три ноги (открытие + два исполнения)', m.matched[0].entryPrice === 29000 && m.matched[0].exitPrice === 29300 && m.matched[0].legs.length === 3);
ok('FIFO: номера сделок сохранены для защиты от дублей', ['B1', 'S1', 'S2'].every((id) => m.matched[0].sourceTransactionIds.includes(id)));
ok('в сводке: 3 сделки, 2 фьючерсных операции', r.stats.deals === 3 && r.stats.tradeOperations === 2);

// 8. Диагностика не содержит счёта.
const diag = api.buildApiDiagnostics({ stats: r.stats, skipped: [], lotByTicker: {}, rawItems: [{ ...buyF, brokerAccountId: 'SECRET-ACCOUNT', cursor: 'c' }] });
ok('диагностика без номера счёта', !diag.includes('SECRET-ACCOUNT'));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки автоимпорта из API прошли ✓');
