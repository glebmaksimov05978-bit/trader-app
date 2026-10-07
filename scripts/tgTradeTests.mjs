// Проверка торговли через Telegram (npm run test:tgtrade). Брокер, хранилище и Telegram — подставные:
// ни одной настоящей заявки, сеть не нужна. Главное, что проверяется: заявка НЕ уходит без второго
// нажатия, количество берётся из позиции брокера, подтверждение одноразовое, защиты работают.
import { prepare, execute, cancel, heldBalance, closeIntent, parseCallback } from '../workers/telegram-webhook/src/tgTrade.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

function world(opts = {}) {
  const kv = new Map(); const calls = []; let n = 0;
  const instrument = { figi: 'FIGI1', uid: 'UID1', ticker: 'SBER', lot: 10, ...(opts.instrument || {}) };
  const accounts = opts.accounts || [{ id: 'A1', name: 'Брокерский' }];
  const positions = opts.positions || { A1: { securities: [{ instrumentUid: 'UID1', figi: 'FIGI1', balance: '100' }], futures: [] } };
  const deps = {
    env: { TICKER_WHITELIST: '*', TINKOFF_TRADE_TOKEN: 'x', ...(opts.env || {}) },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    kvPut: async (k, v) => { kv.set(k, v); },
    kvGet: async (k) => kv.get(k) ?? null,
    kvDelete: async (k) => { kv.delete(k); },
    resolveInstrument: async () => (opts.noInstrument ? null : instrument),
    listAccounts: async () => accounts,
    tinkoff: async (method, body) => {
      calls.push({ method, body });
      if (method === 'OperationsService/GetPositions') {
        const second = calls.filter((c) => c.method === method).length > 1;
        return opts.positionsAfter && second ? opts.positionsAfter : positions[body.accountId] || {};
      }
      if (method === 'MarketDataService/GetLastPrices') return { lastPrices: [{ price: { units: '300', nano: 0 } }] };
      if (method === 'OrdersService/PostOrder') {
        if (opts.reject) throw new Error('PostOrder: 400 not trading');
        return { orderId: body.orderId, lotsExecuted: opts.lotsExecuted ?? body.quantity, executionReportStatus: 'EXECUTION_REPORT_STATUS_FILL' };
      }
      if (method === 'OrdersService/GetOrderState') {
        if (opts.noAvg) return {};
        return { averagePositionPrice: { units: '301', nano: 500000000 } };
      }
      return {};
    },
  };
  return { deps, kv, calls };
}
const posts = (w) => w.calls.filter((c) => c.method === 'OrdersService/PostOrder');

// чистые функции
ok('баланс акции из ответа брокера', heldBalance({ securities: [{ instrumentUid: 'U', balance: '30' }] }, { uid: 'U' }) === 30);
ok('шорт — отрицательный баланс', heldBalance({ futures: [{ figi: 'F', balance: '-3' }] }, { figi: 'F' }) === -3);
ok('нет позиции — 0', heldBalance({ securities: [] }, { uid: 'U' }) === 0);
ok('лонг 100 шт при лоте 10 → продать 10 лот.', JSON.stringify(closeIntent(100, { lot: 10 }, 'stock')) === '{"lots":10,"direction":"sell","remainder":0}');
ok('шорт 3 фьюча → купить 3', closeIntent(-3, { lot: 1 }, 'future').direction === 'buy' && closeIntent(-3, { lot: 1 }, 'future').lots === 3);
ok('остаток меньше лота отмечается', closeIntent(105, { lot: 10 }, 'stock').remainder === 5);
ok('меньше лота — 0 лотов', closeIntent(5, { lot: 10 }, 'stock').lots === 0);
ok('разбор кнопок', parseCallback('x|c|abc123')?.action === 'c' && parseCallback('x|go|00000000-0000-4000-8000-000000000001')?.action === 'go' && parseCallback('d|id|sk') === null && parseCallback('x|zz|abc123') === null);

// закрытие: шаг 1 ничего не отправляет
let w = world();
let r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock', tradeId: 'T1', tradeDirection: 'long' });
ok('шаг 1: показано подтверждение «продать 10 лот.»', /продать 10 лот/.test(r.text) && r.keyboard?.inline_keyboard[0].length === 2);
ok('шаг 1: заявка брокеру НЕ ушла', posts(w).length === 0);
ok('шаг 1: подтверждение лежит в хранилище', [...w.kv.keys()].some((k) => k.startsWith('x:')));

// шаг 2
let ex = await execute(w.deps, r.nonce);
ok('шаг 2: ушла ровно одна заявка по рынку, продажа 10 лот.', posts(w).length === 1 && posts(w)[0].body.quantity === '10' && posts(w)[0].body.direction === 'ORDER_DIRECTION_SELL' && posts(w)[0].body.orderType === 'ORDER_TYPE_MARKET');
ok('шаг 2: orderId = nonce (идемпотентность)', posts(w)[0].body.orderId === r.nonce);
ok('шаг 2: цена исполнения из состояния заявки 301.5, запись для журнала создана', /301\.5/.test(ex.text) && JSON.parse(w.kv.get(`fill:${r.nonce}`)).price === 301.5);
ok('шаг 2: подтверждение израсходовано', !w.kv.has(`x:${r.nonce}`));
ex = await execute(w.deps, r.nonce);
ok('повторное «Да» не создаёт второй заявки', posts(w).length === 1 && /устарело|использовано/.test(ex.text));

// цена-ориентир
w = world({ noAvg: true });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock', tradeId: 'T1' });
ex = await execute(w.deps, r.nonce);
ok('нет цены исполнения → последняя цена с пометкой «ориентир»', /ориентир/.test(ex.text) && JSON.parse(w.kv.get(`fill:${r.nonce}`)).priceApprox === true);

// защиты при закрытии
w = world({ positions: { A1: { securities: [], futures: [] } } });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ok('позиции у брокера нет → закрывать нечего, подтверждения нет', r.error && /нет/.test(r.text) && [...w.kv.keys()].length === 0);

w = world({ accounts: [{ id: 'A1', name: 'Один' }, { id: 'A2', name: 'ИИС' }], positions: { A1: { securities: [{ instrumentUid: 'UID1', balance: '10' }] }, A2: { securities: [{ instrumentUid: 'UID1', balance: '20' }] } } });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ok('позиция на нескольких счетах → не гадаем', r.error && /нескольких счетах/.test(r.text));

w = world({ env: { TRADING_DISABLED: 'true' } });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ok('стоп-кран блокирует уже на шаге 1', r.error && /стоп-кран/.test(r.text) && posts(w).length === 0);

w = world();
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
w.deps.env.TRADING_DISABLED = 'true';
ex = await execute(w.deps, r.nonce);
ok('стоп-кран, включённый между шагами, блокирует заявку', /стоп-кран/.test(ex.text) && posts(w).length === 0);

w = world({ positionsAfter: { securities: [{ instrumentUid: 'UID1', balance: '50' }] } });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ex = await execute(w.deps, r.nonce);
ok('позиция изменилась между шагами → заявка НЕ отправлена', /изменилась/.test(ex.text) && posts(w).length === 0);

w = world({ env: { TICKER_WHITELIST: 'GAZP' } });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ok('тикер не в белом списке → отказ', r.error && /белом списке/.test(r.text));

w = world({ reject: true });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ex = await execute(w.deps, r.nonce);
ok('брокер отклонил → понятное сообщение, записи для журнала нет', /отклонил/.test(ex.text) && ![...w.kv.keys()].some((k) => k.startsWith('fill:')));

w = world({ lotsExecuted: 0 });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ex = await execute(w.deps, r.nonce);
ok('не исполнено сразу → просим внести вручную, записи для журнала нет', /не вернул|не подтверждено/.test(ex.text) && ![...w.kv.keys()].some((k) => k.startsWith('fill:')));

w = world({ env: { MAX_ORDER_RUB: '1000' } });
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
ok('потолок суммы MAX_ORDER_RUB работает', r.error && /разрешённой/.test(r.text));

// шорт по фьючерсу — закрытие покупкой
w = world({ instrument: { lot: 1 }, positions: { A1: { futures: [{ instrumentUid: 'UID1', balance: '-3' }] } } });
r = await prepare(w.deps, { kind: 'close', ticker: 'MXZ6', instrumentType: 'future', tradeDirection: 'short' });
ex = await execute(w.deps, r.nonce);
ok('шорт 3 фьючерса закрывается ПОКУПКОЙ 3', posts(w)[0].body.direction === 'ORDER_DIRECTION_BUY' && posts(w)[0].body.quantity === '3');

// открытие по бумажной
w = world();
r = await prepare(w.deps, { kind: 'open', ticker: 'SBER', instrumentType: 'stock', direction: 'buy', lots: 5, paperId: 'P1', tradeDirection: 'long' });
ok('открытие: подтверждение «купить 5 лот.» и предупреждение про стоп', /купить 5 лот/.test(r.text) && /Стоп и цель/.test(r.text) && posts(w).length === 0);
ex = await execute(w.deps, r.nonce);
ok('открытие: одна заявка на покупку 5, запись для журнала с paperId', posts(w).length === 1 && posts(w)[0].body.direction === 'ORDER_DIRECTION_BUY' && JSON.parse(w.kv.get(`fill:${r.nonce}`)).paperId === 'P1');
w = world({ accounts: [{ id: 'A1', name: 'a' }, { id: 'A2', name: 'b' }] });
r = await prepare(w.deps, { kind: 'open', ticker: 'SBER', instrumentType: 'stock', direction: 'buy', lots: 5 });
ok('открытие при нескольких счетах — не гадаем', r.error && /нескольк/.test(r.text));
r = await prepare(world().deps, { kind: 'open', ticker: 'SBER', instrumentType: 'stock', direction: 'buy', lots: 0 });
ok('нулевой объём бумажной — отказ', r.error);

// отмена
w = world();
r = await prepare(w.deps, { kind: 'close', ticker: 'SBER', instrumentType: 'stock' });
await cancel(w.deps, r.nonce);
ex = await execute(w.deps, r.nonce);
ok('после «Отмена» подтвердить нельзя', /устарело|использовано/.test(ex.text) && posts(w).length === 0);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки торговли через Telegram прошли ✓');
