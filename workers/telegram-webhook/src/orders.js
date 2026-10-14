// workers/telegram-webhook/src/orders.js
//
// Отправка заявки брокеру — единственная операция приложения, которая тратит настоящие
// деньги. Отсюда весь дизайн этого файла.
//
// ПРАВИЛО ПЕРВОЕ: торговый токен никогда не попадает в браузер. Он живёт секретом
// воркера (`wrangler secret put TINKOFF_TRADE_TOKEN`) и не покидает сервер. Браузер
// присылает намерение — «купить SBER, 3 лота, лимит 285» — и Firebase ID-токен, который
// доказывает, что это владелец. Всё остальное решает сервер.
//
// ПРАВИЛО ВТОРОЕ: никакой автономии. Заявка уходит только в ответ на явное нажатие
// человека; здесь нет ни расписания, ни реакции на сигналы. Приложение предлагает,
// нажимает трейдер — это его прямое требование, и оно вшито в архитектуру: у воркера
// просто нет способа отправить заявку самому.
//
// ПРАВИЛО ТРЕТЬЕ: ограничения проверяются на сервере, а не в интерфейсе. Проверка в
// браузере — это подсказка, обойти её может кто угодно, включая ошибку в самом коде.
// Поэтому белый список инструментов, стоп-кран и потолок суммы живут здесь.
//
// ПРАВИЛО ЧЕТВЁРТОЕ: тикер резолвится на сервере. Если бы браузер присылал готовый figi,
// подменённый запрос купил бы что угодно; при резолве по тикеру белый список проверяет
// ровно то, что трейдер видит на экране.
import { verifyFirebaseToken } from './verifyFirebaseToken.js';

// Адрес REST API брокера. Менять через env.TINKOFF_BASE (например, на новый домен tbank.ru) без правки кода.
const TINKOFF_DEFAULT_BASE = 'https://invest-public-api.tinkoff.ru/rest';
const CONTRACT = 'tinkoff.public.invest.api.contract.v1';

// Есть ли у этого экземпляра способ говорить с брокером: торговый токен здесь ИЛИ посредник
// (RELAY_URL), у которого токен лежит. Токен в этом случае на воркере не нужен и не хранится.
export function hasBrokerAccess(env) {
  return !!(env.TINKOFF_TRADE_TOKEN || env.RELAY_URL);
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

// Браузер ходит сюда с другого домена, поэтому CORS обязателен. Origin ограничен
// списком из настроек: чужая страница не должна уметь дёргать этот адрес из браузера
// трейдера, пока он залогинен.
function corsHeaders(env) {
  const allowed = (env?.ALLOWED_ORIGIN || '*');
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

/**
 * Один вызов REST API брокера.
 *
 * Два пути:
 *   • напрямую (есть TINKOFF_TRADE_TOKEN) — как раньше. С зарубежных серверов, включая
 *     Cloudflare, сейчас не работает: сертификат API выдан российским центром, которому они не
 *     доверяют (ошибка 526);
 *   • через российского посредника (RELAY_URL + RELAY_KEY, см. relay/) — посредник стоит в
 *     России, доверяет сертификату и хранит торговый токен. Сюда токен уже не попадает.
 */
export async function tinkoff(env, method, body) {
  if (env.RELAY_URL) return tinkoffViaRelay(env, method, body);
  return tinkoffDirect(env, method, body);
}

export async function tinkoffDirect(env, method, body) {
  const base = String(env.TINKOFF_BASE || TINKOFF_DEFAULT_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/${CONTRACT}.${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TINKOFF_TRADE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parseBrokerResponse(res, method);
}

/**
 * Полный адрес вызова посредника. На обычном сервере — база + путь. У Яндекс Облака путь после
 * идентификатора функции недопустим, поэтому для functions.yandexcloud.net маршрут уходит
 * параметром: <адрес>?integration=raw&route=/broker/<метод>.
 */
export function relayEndpoint(base, path) {
  const b = String(base).replace(/\/+$/, '');
  if (/functions\.yandexcloud\.net/.test(b) || b.includes('?')) {
    const [clean, query] = b.split('?');
    const params = new URLSearchParams(query || '');
    params.set('route', path);
    return `${clean}?${params.toString()}`;
  }
  return `${b}${path}`;
}

async function tinkoffViaRelay(env, method, body) {
  if (!env.RELAY_KEY) throw new Error('Для посредника не задан RELAY_KEY');
  // Основной адрес и (необязательно) запасной RELAY_URL_BACKUP — второй экземпляр на другом
  // хостинге. К запасному переходим, только если основной не отвечает вовсе или вернул ошибку
  // сервера (5xx). Ошибки брокера (4xx) переходом не лечатся — они придут и с запасного.
  // Повторная отправка заявки безопасна: PostOrder идёт с одним и тем же orderId, брокер сам
  // отсекает дубль.
  const urls = [env.RELAY_URL, env.RELAY_URL_BACKUP].filter(Boolean).map((u) => String(u).replace(/\/+$/, ''));
  let lastError = null;
  for (const base of urls) {
    try {
      const res = await fetch(relayEndpoint(base, `/broker/${method}`), {
        method: 'POST',
        headers: { 'X-Relay-Key': env.RELAY_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status >= 500 && base !== urls[urls.length - 1]) {
        lastError = new Error(`${method}: посредник ответил ${res.status}`);
        continue;
      }
      return await parseBrokerResponse(res, method);
    } catch (e) {
      lastError = e;
      // Ответ получен и разобран (ошибка брокера) — это уже не «посредник недоступен».
      if (/^\S+: \d{3} /.test(e.message) && !/: 5\d\d /.test(e.message)) throw e;
    }
  }
  throw lastError || new Error('Посредник недоступен');
}

async function parseBrokerResponse(res, method) {
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* пусто */ }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || parsed?.description || text.slice(0, 300);
    throw new Error(`${method}: ${res.status} ${msg}`);
  }
  return parsed;
}

// Цена у Tinkoff — не число, а units/nano (целая часть и миллиардные доли). Обычный
// float здесь однажды даст 284.99999999 вместо 285, и заявка уйдёт по другой цене.
function toQuotation(price) {
  const units = Math.trunc(price);
  const nano = Math.round((price - units) * 1e9);
  return { units: String(units), nano };
}

export function quotationToFloat(q) {
  if (!q) return null;
  return (Number(q.units) || 0) + (Number(q.nano) || 0) / 1e9;
}

function parseList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Все проверки, которые не требуют сети, — одной чистой функцией. Вынесены отдельно
 * намеренно: это единственный код в приложении, ошибка в котором стоит денег, и он
 * должен проверяться тестами без торгового токена и без единой настоящей заявки.
 *
 * @returns {{ok: true, intent: object} | {ok: false, status: number, error: string}}
 */
export function checkOrderGates(env, body) {
  // Стоп-кран проверяется ПЕРВЫМ: когда его дёрнули, всё остальное уже неважно.
  if (String(env.TRADING_DISABLED || '').toLowerCase() === 'true') {
    return { ok: false, status: 503, error: 'Отправка заявок выключена стоп-краном на сервере.' };
  }
  if (!hasBrokerAccess(env)) {
    return { ok: false, status: 503, error: 'На сервере не задан торговый токен или посредник — отправка заявок не настроена.' };
  }
  // Номер счёта здесь НЕ проверяется: один торговый токен может открывать доступ сразу
  // к нескольким счетам (обычный/ИИС и т.д.), поэтому счёт выбирается в самой заявке
  // (body.accountId), а не зашивается на сервере одним значением. Резолвится и
  // проверяется он ниже, в handleOrder — там же, где нужен реальный список счетов
  // с биржи, а не здесь, в синхронной проверке без сети.
  if (!body) return { ok: false, status: 400, error: 'Тело запроса не разобрано' };

  const ticker = String(body.ticker || '').trim().toUpperCase();
  const direction = body.direction === 'sell' ? 'sell' : 'buy';
  const lots = Math.floor(Number(body.lots));
  const orderType = body.orderType === 'market' ? 'market' : 'limit';
  const price = body.price != null ? Number(body.price) : null;

  if (!ticker) return { ok: false, status: 400, error: 'Не указан тикер' };
  if (!Number.isFinite(lots) || lots < 1) {
    return { ok: false, status: 400, error: 'Количество лотов должно быть целым числом от 1' };
  }
  if (orderType === 'limit' && (!Number.isFinite(price) || price <= 0)) {
    return { ok: false, status: 400, error: 'Для лимитной заявки нужна цена' };
  }

  // Белый список. Пустой означает «не разрешено ничего», а не «разрешено всё»:
  // молчание в настройках не должно открывать доступ к деньгам. Разрешить ЛЮБОЙ
  // тикер можно только явным "*" — сознательным включением, а не тем, что сработало
  // по умолчанию, если список забыли заполнить.
  const raw = String(env.TICKER_WHITELIST || '').trim();
  const wildcard = raw === '*';
  const whitelist = wildcard ? [] : parseList(raw);
  if (!wildcard) {
    if (!whitelist.length) {
      return { ok: false, status: 403, error: 'Белый список инструментов пуст — отправка заявок запрещена.' };
    }
    if (!whitelist.includes(ticker)) {
      return { ok: false, status: 403, error: `${ticker} нет в белом списке разрешённых инструментов.` };
    }
  }

  return { ok: true, intent: { ticker, direction, lots, orderType, price, dryRun: !!body.dryRun } };
}

// Список счетов, которые открывает этот торговый токен. Один трейдер обычно имеет
// несколько (обычный брокерский, ИИС...) — поэтому счёт нельзя зашивать в настройках
// одним значением, его выбирают в самой заявке, а здесь только проверяют, что выбранный
// счёт действительно принадлежит этому токену (а не подставлен произвольно из браузера).
export async function listAccounts(env) {
  const data = await tinkoff(env, 'UsersService/GetAccounts', {});
  return (data?.accounts || [])
    .filter((a) => a.status === 'ACCOUNT_STATUS_OPEN')
    .map((a) => ({
      id: a.id,
      name: a.name || a.id,
      type: a.type || null,
    }));
}

export async function resolveInstrument(env, ticker, instrumentType) {
  const kind = instrumentType === 'future' ? 'INSTRUMENT_TYPE_FUTURES'
    : instrumentType === 'currency' ? 'INSTRUMENT_TYPE_CURRENCY'
      : 'INSTRUMENT_TYPE_SHARE';
  const data = await tinkoff(env, 'InstrumentsService/FindInstrument', {
    query: ticker,
    instrumentKind: kind,
    apiTradeAvailableFlag: true,
  });
  const list = data?.instruments || [];
  const exact = list.find((i) => (i.ticker || '').toUpperCase() === ticker);
  const match = exact || null;
  if (!match) return null;
  return {
    figi: match.figi,
    uid: match.uid || null,
    ticker: (match.ticker || '').toUpperCase(),
    name: match.name || match.ticker,
    lot: Number(match.lot) || 1,
  };
}

/**
 * POST /order
 * Тело: { ticker, instrumentType, direction: 'buy'|'sell', lots, orderType: 'limit'|'market',
 *         price?, requestId, dryRun? }
 * Заголовок: Authorization: Bearer <firebase id token>
 */
export async function handleOrder(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (request.method !== 'POST') return json(env, { error: 'только POST' }, 405);

  // 1. Кто просит. Без доказанного владельца дальше не идём.
  const auth = request.headers.get('Authorization') || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const who = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID, env.OWNER_UID);
  if (!who.ok) return json(env, { error: `Доступ запрещён: ${who.error}` }, 403);

  // 2. Стоп-кран, настройки сервера, разбор намерения и белый список — всё в одной
  // чистой функции выше, чтобы это можно было проверить тестами.
  const body = await request.json().catch(() => null);
  const gate = checkOrderGates(env, body);
  if (!gate.ok) return json(env, { error: gate.error }, gate.status);
  const { ticker, direction, lots, orderType, price, dryRun } = gate.intent;

  // 3. Какой счёт. Браузер присылает id счёта, который трейдер выбрал в окне
  // подтверждения, — но сервер не доверяет ему вслепую: id сверяется со СПИСКОМ
  // РЕАЛЬНЫХ счетов этого токена, полученным прямо у брокера. Иначе подменённый запрос
  // мог бы указать чужой accountId и отправить заявку не туда.
  let accounts;
  try {
    accounts = await listAccounts(env);
  } catch (e) {
    return json(env, { error: `Не удалось получить список счетов: ${e.message}` }, 502);
  }
  if (!accounts.length) {
    return json(env, { error: 'У этого токена нет открытых счетов на бирже.' }, 502);
  }
  const requestedAccountId = String(body.accountId || '').trim();
  const account = requestedAccountId
    ? accounts.find((a) => a.id === requestedAccountId)
    : (accounts.length === 1 ? accounts[0] : null);
  if (!account) {
    return json(env, {
      error: requestedAccountId
        ? 'Указанный счёт не найден среди счетов по этому токену.'
        : 'У токена несколько счетов — нужно выбрать, на какой отправлять заявку.',
      accounts,
    }, 400);
  }

  // 4. Что именно покупаем. Резолвит сервер, а не браузер.
  let instrument;
  try {
    instrument = await resolveInstrument(env, ticker, body.instrumentType);
  } catch (e) {
    return json(env, { error: `Не удалось найти инструмент: ${e.message}` }, 502);
  }
  if (!instrument) return json(env, { error: `Инструмент ${ticker} не найден или недоступен для торговли через API.` }, 404);

  // 5. Потолок суммы, если задан. По умолчанию не задан — трейдер выбрал только белый
  // список; одна переменная MAX_ORDER_RUB включает и эту защиту, если понадобится.
  const maxRub = Number(env.MAX_ORDER_RUB) || null;
  let estimate = null;
  if (orderType === 'limit') {
    estimate = price * lots * instrument.lot;
  } else {
    try {
      const lp = await tinkoff(env, 'MarketDataService/GetLastPrices', { figi: [instrument.figi] });
      const last = quotationToFloat(lp?.lastPrices?.[0]?.price);
      if (last) estimate = last * lots * instrument.lot;
    } catch { /* оценка необязательна */ }
  }
  if (maxRub && estimate && estimate > maxRub) {
    return json(env, {
      error: `Сумма заявки ≈ ${Math.round(estimate).toLocaleString('ru-RU')} ₽ больше разрешённой на сервере (${maxRub.toLocaleString('ru-RU')} ₽).`,
    }, 403);
  }

  const preview = {
    ticker: instrument.ticker,
    name: instrument.name,
    figi: instrument.figi,
    lotSize: instrument.lot,
    lots,
    units: lots * instrument.lot,
    direction,
    orderType,
    price: orderType === 'limit' ? price : null,
    estimateRub: estimate != null ? Math.round(estimate) : null,
    accountId: account.id,
    accountName: account.name,
  };

  // 6. Сухой прогон: всё проверено, но брокеру ничего не ушло. Так интерфейс показывает
  // трейдеру, что именно уйдёт, и так эта ветка проверяется без единой настоящей сделки.
  if (dryRun) return json(env, { ok: true, dryRun: true, preview });

  // 7. Отправка. requestId — ключ идемпотентности: два нажатия подряд (или повтор из-за
  // сети) не превратятся в две заявки, брокер вернёт ту же самую.
  const orderId = String(body.requestId || '').slice(0, 36) || crypto.randomUUID();
  try {
    const res = await tinkoff(env, 'OrdersService/PostOrder', {
      accountId: account.id,
      instrumentId: instrument.uid || instrument.figi,
      quantity: String(lots),
      direction: direction === 'sell' ? 'ORDER_DIRECTION_SELL' : 'ORDER_DIRECTION_BUY',
      orderType: orderType === 'market' ? 'ORDER_TYPE_MARKET' : 'ORDER_TYPE_LIMIT',
      orderId,
      ...(orderType === 'limit' ? { price: toQuotation(price) } : {}),
    });
    return json(env, {
      ok: true,
      preview,
      order: {
        orderId: res?.orderId || orderId,
        status: res?.executionReportStatus || null,
        lotsExecuted: res?.lotsExecuted != null ? Number(res.lotsExecuted) : null,
        executedPrice: quotationToFloat(res?.executedOrderPrice),
        message: res?.message || null,
      },
    });
  } catch (e) {
    let hint = '';
    if (/outside the limits/i.test(e.message)) {
      try {
        const lp = await tinkoff(env, 'MarketDataService/GetLastPrices', { figi: [instrument.figi] });
        const last = quotationToFloat(lp?.lastPrices?.[0]?.price);
        if (last) hint = ` Сейчас цена около ${last}.`;
      } catch { /* подсказка необязательна */ }
    }
    return json(env, { error: `Брокер отклонил заявку: ${explainBrokerError(e.message)}${hint}` }, 502);
  }
}

/**
 * Ошибка брокера человеческим языком. Т-Банк присылает технический английский текст с
 * названием метода и кодом («OrdersService/PostOrder: 400 The price is outside the limits…») —
 * трейдеру нужно по-русски понимать, ПОЧЕМУ не ушла заявка и что делать. Известные причины
 * переводятся; неизвестные показываются как есть, но без служебных приставок.
 */
export function translateBrokerError(message) {
  const raw = String(message || '');
  // Приставки «Сервис/Метод: 400» (иногда задвоенные посредником) — служебные, трейдеру не нужны.
  const clean = raw.replace(/\b[A-Za-z]+Service\/\w+:\s*\d{3}\s*/g, '').replace(/\s+/g, ' ').trim();
  const t = clean.toLowerCase();
  const rules = [
    [/insufficient privileges|permission denied|forbidden/, 'У токена нет права выставлять заявки. Выпустите токен с доступом «Полный доступ» (не «только чтение») и замените его на сервере.'],
    [/price is outside the limits|outside the limits/, 'Цена вне допустимого диапазона: биржа принимает лимитные заявки только недалеко от текущей цены. Поставьте цену ближе к рыночной или выберите рыночную заявку.'],
    [/not enough|insufficient (balance|funds|assets)|недостаточно/, 'Недостаточно средств или бумаг на счёте для этой заявки.'],
    [/not available for trading|trading is not available|instrument.*(unavailable|forbidden|not allowed)|api trade/, 'Этот инструмент нельзя торговать через API (или торги им сейчас закрыты). Откройте заявку в приложении брокера.'],
    [/not.?trading|trading.?not.?available|instrument.?status|market.?closed|session|клиринг|торги.*не\s*ведутся|недоступ.*торг/, 'Сейчас биржа не торгует этим инструментом (вне сессии, клиринг или выходной). Заявка в очередь «на потом» не встаёт — отправьте её, когда торги откроются.'],
    [/invalid (quantity|lot)|quantity.*(must|invalid|less)|lot/, 'Количество лотов не подходит для этого инструмента.'],
    [/token|unauthenticated|authentication/, 'Брокер не принял токен. Проверьте, что токен действителен и вставлен без лишних пробелов.'],
    [/too many requests|rate limit|resource.?exhausted/, 'Слишком много запросов к брокеру подряд. Подождите минуту и повторите.'],
    [/duplicate|already|idempotenc/, 'Такая заявка уже была отправлена (повторное нажатие не создаёт вторую).'],
    [/short|margin|маржин/, 'Недостаточно обеспечения для такой позиции (проверьте маржинальные требования и разрешение на шорт).'],
  ];
  for (const [re, ru] of rules) {
    if (re.test(t)) return `${ru}${clean ? ` (ответ брокера: ${clean})` : ''}`;
  }
  return clean || 'Брокер отклонил заявку без пояснения.';
}

// Совместимость: прежнее имя.
function explainBrokerError(message) { return translateBrokerError(message); }

/**
 * GET /order/config — что разрешено на сервере. Нужен интерфейсу, чтобы не предлагать
 * кнопку там, где заявка всё равно не уйдёт. Торгового токена не раскрывает.
 */
export async function handleOrderConfig(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  const auth = request.headers.get('Authorization') || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const who = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID, env.OWNER_UID);
  if (!who.ok) return json(env, { enabled: false, reason: who.error }, 403);

  const rawWhitelist = String(env.TICKER_WHITELIST || '').trim();
  const wildcard = rawWhitelist === '*';
  const whitelist = wildcard ? [] : parseList(rawWhitelist);
  const disabled = String(env.TRADING_DISABLED || '').toLowerCase() === 'true';

  // Список счетов запрашивается здесь же, чтобы окно подтверждения заявки не делало
  // отдельный поход на сервер только ради выпадающего списка. Ошибка получения счетов —
  // не повод ломать весь ответ: кнопка просто останется недоступной с понятной причиной.
  let accounts = [];
  let accountsError = null;
  if (hasBrokerAccess(env) && !disabled) {
    try {
      accounts = await listAccounts(env);
      if (!accounts.length) accountsError = 'у токена нет открытых счетов';
    } catch (e) {
      accountsError = e.message;
    }
  }

  return json(env, {
    enabled: !disabled && hasBrokerAccess(env) && (wildcard || whitelist.length > 0) && accounts.length > 0,
    killSwitch: disabled,
    whitelist,
    // Явный флаг для интерфейса: "*" значит «любой тикер», а не «список из одного
    // символа со звёздочкой». Фронтенд проверяет его вместо whitelist.includes(ticker).
    wildcard,
    maxOrderRub: Number(env.MAX_ORDER_RUB) || null,
    accounts,
    accountsError,
  });
}
