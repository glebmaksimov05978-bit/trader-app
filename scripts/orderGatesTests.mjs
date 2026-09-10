// scripts/orderGatesTests.mjs
//
// Проверка серверных ограничений на заявки: npm run test:orders
//
// Проверка серверных ограничений на заявки. Ни одной настоящей заявки здесь нет и быть
// не может: checkOrderGates — чистая функция, она ничего не отправляет.
import { checkOrderGates } from '../workers/telegram-webhook/src/orders.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('  ПРОВАЛ:', m); fails++; } };

const ENV = {
  TINKOFF_TRADE_TOKEN: 'фиктивный-токен-для-теста',
  TINKOFF_ACCOUNT_ID: '0000',
  TICKER_WHITELIST: 'SBER, GAZP LKOH',
};
const GOOD = { ticker: 'SBER', direction: 'buy', lots: 3, orderType: 'limit', price: 285.5 };

const r = (env, body) => checkOrderGates({ ...ENV, ...env }, body);

// нормальный случай
const good = r({}, GOOD);
ok(good.ok, `нормальная заявка должна проходить: ${good.error}`);
ok(good.intent.ticker === 'SBER' && good.intent.lots === 3 && good.intent.price === 285.5, 'намерение разобрано');

// стоп-кран важнее всего остального
const killed = r({ TRADING_DISABLED: 'true' }, GOOD);
ok(!killed.ok && killed.status === 503, 'стоп-кран останавливает заявку');
ok(!r({ TRADING_DISABLED: 'TRUE' }, GOOD).ok, 'стоп-кран нечувствителен к регистру');
ok(r({ TRADING_DISABLED: 'false' }, GOOD).ok, '"false" не считается включённым стоп-краном');

// белый список
ok(!r({}, { ...GOOD, ticker: 'VTBR' }).ok, 'тикера нет в списке — отказ');
ok(r({}, { ...GOOD, ticker: 'gazp' }).ok, 'регистр тикера не важен');
ok(r({}, { ...GOOD, ticker: ' LKOH ' }).ok, 'пробелы обрезаются');
const empty = r({ TICKER_WHITELIST: '' }, GOOD);
ok(!empty.ok && empty.status === 403, 'ПУСТОЙ список запрещает всё, а не разрешает всё');
ok(!r({ TICKER_WHITELIST: '   ' }, GOOD).ok, 'список из пробелов тоже запрещает всё');

// настройки сервера
ok(!r({ TINKOFF_TRADE_TOKEN: '' }, GOOD).ok, 'без торгового токена — отказ');
ok(!r({ TINKOFF_ACCOUNT_ID: '' }, GOOD).ok, 'без номера счёта — отказ');

// разбор параметров
ok(!r({}, null).ok, 'пустое тело');
ok(!r({}, { ...GOOD, ticker: '' }).ok, 'пустой тикер');
ok(!r({}, { ...GOOD, lots: 0 }).ok, 'ноль лотов');
ok(!r({}, { ...GOOD, lots: -5 }).ok, 'отрицательные лоты');
ok(!r({}, { ...GOOD, lots: 'много' }).ok, 'лоты не число');
ok(r({}, { ...GOOD, lots: 2.9 }).intent.lots === 2, 'дробные лоты округляются вниз');
ok(!r({}, { ...GOOD, orderType: 'limit', price: null }).ok, 'лимитная без цены');
ok(!r({}, { ...GOOD, orderType: 'limit', price: 0 }).ok, 'лимитная с нулевой ценой');
ok(!r({}, { ...GOOD, orderType: 'limit', price: -10 }).ok, 'лимитная с отрицательной ценой');
ok(r({}, { ...GOOD, orderType: 'market', price: null }).ok, 'рыночной цена не нужна');

// направление и тип по умолчанию — самые безопасные
ok(r({}, { ...GOOD, direction: 'что-то' }).intent.direction === 'buy', 'непонятное направление → buy');
ok(r({}, { ...GOOD, orderType: 'что-то' }).intent.orderType === 'limit', 'непонятный тип → лимитная (не рыночная)');
ok(r({}, { ...GOOD, direction: 'sell' }).intent.direction === 'sell', 'продажа проходит');

// сухой прогон — просто флаг, на проверки не влияет
ok(r({}, { ...GOOD, dryRun: true }).intent.dryRun === true, 'dryRun пробрасывается');
ok(!r({}, { ...GOOD, ticker: 'VTBR', dryRun: true }).ok, 'сухой прогон не обходит белый список');

console.log(fails === 0 ? 'Все проверки ограничений прошли ✓' : `${fails} проверок провалено`);
process.exit(fails ? 1 : 0);
