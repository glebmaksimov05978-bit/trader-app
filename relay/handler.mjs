// relay/handler.mjs
//
// Российский посредник между приложением и API Т-Банка.
//
// Зачем он нужен: сертификат API Т-Банка выдан российским национальным центром, и серверы за
// рубежом (Cloudflare Workers, GitHub, Vercel…) ему не доверяют — любой вызов оттуда даёт
// ошибку 526. Сервер в России (с добавленным корневым сертификатом) доверяет и работает.
// Поэтому торговый токен и сами вызовы брокера живут ЗДЕСЬ, а всё остальное приложение
// обращается к брокеру только через этот сервис.
//
// Код написан на стандартных Request/Response и не привязан к хостингу: один и тот же handle()
// запускается в Яндекс Облаке (relay/yandex.mjs), на любом российском сервере или VPS
// (relay/server.mjs) и в Docker. Поменять площадку — значит поменять обёртку, не логику.
//
// Три группы адресов:
//   GET  /health            — жив ли сервис и подключён ли сертификат (без секретов);
//   POST /broker/<Метод>    — узкий прокси к брокеру для доверенных серверов (воркер Telegram),
//                             по ключу X-Relay-Key; только разрешённые методы;
//   POST /order, /order/config — то же, что у воркера: заявка из браузера по Firebase-токену
//                             (приложение может указать адрес посредника в Настройках напрямую).
//
// ГЛАВНЫЕ ПРАВИЛА (те же, что у воркера):
//   1. Торговый токен только в переменных окружения этого сервиса; наружу не отдаётся никогда.
//   2. Никакой автономии: ничего не отправляется без запроса от доверенной стороны, у сервиса
//      нет ни расписания, ни реакции на сигналы.
//   3. Стоп-кран TRADING_DISABLED=true выключает отправку заявок мгновенно.
import { handleOrder, handleOrderConfig, tinkoffDirect } from '../workers/telegram-webhook/src/orders.js';

// Методы API брокера, которые посредник готов выполнить. Всё остальное — 403: узкий список —
// единственное, что мешает утёкшему ключу превратиться в «делай что хочешь с моим счётом».
export const ALLOWED_METHODS = new Set([
  'UsersService/GetAccounts',
  'OperationsService/GetPositions',
  'OperationsService/GetPortfolio',
  'OperationsService/GetOperationsByCursor',
  'MarketDataService/GetLastPrices',
  'MarketDataService/GetCandles',
  'InstrumentsService/FindInstrument',
  'InstrumentsService/ShareBy',
  'InstrumentsService/FutureBy',
  'OrdersService/PostOrder',
  'OrdersService/GetOrderState',
  'OrdersService/GetOrders',
]);
// Только они меняют состояние счёта — для них проверяется стоп-кран.
const WRITE_METHODS = new Set(['OrdersService/PostOrder']);

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

// Сравнение секретов без раннего выхода по первому несовпавшему символу.
function safeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function brokerEnv(env) {
  // Посредник обращается к брокеру НАПРЯМУЮ — RELAY_URL здесь быть не должен (иначе петля).
  return { ...env, RELAY_URL: undefined };
}

async function handleBroker(request, env, method) {
  if (request.method !== 'POST') return json({ error: 'только POST' }, 405);
  if (!env.RELAY_KEY) return json({ error: 'На посреднике не задан RELAY_KEY — прокси выключен.' }, 503);
  if (!safeEqual(request.headers.get('X-Relay-Key'), env.RELAY_KEY)) return json({ error: 'forbidden' }, 403);
  if (!ALLOWED_METHODS.has(method)) return json({ error: `Метод ${method} не разрешён на посреднике.` }, 403);
  if (!env.TINKOFF_TRADE_TOKEN) return json({ error: 'На посреднике не задан торговый токен.' }, 503);
  if (WRITE_METHODS.has(method) && String(env.TRADING_DISABLED || '').toLowerCase() === 'true') {
    return json({ error: 'Отправка заявок выключена стоп-краном на посреднике.' }, 503);
  }
  const body = await request.json().catch(() => ({}));
  try {
    const data = await tinkoffDirect(brokerEnv(env), method, body);
    return json(data ?? {});
  } catch (e) {
    // Текст ошибки брокера нужен вызывающей стороне; статус у брокера уже вшит в сообщение.
    const m = /: (\d{3}) /.exec(e.message);
    return json({ error: e.message }, m ? Number(m[1]) : 502);
  }
}

/** Главный обработчик: любой хостинг делает new Request(...) и отдаёт результат клиенту. */
export async function handle(request, env = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      },
    });
  }

  if (path === '/' || path === '/health') {
    return json({
      ok: true,
      service: 'traderpro-relay',
      // Ничего секретного — только «настроено / нет», чтобы по одному адресу было видно, чего не хватает.
      brokerToken: !!env.TINKOFF_TRADE_TOKEN,
      relayKey: !!env.RELAY_KEY,
      russianCa: !!(env.NODE_EXTRA_CA_CERTS || env.EXTRA_CA_CONFIGURED),
      killSwitch: String(env.TRADING_DISABLED || '').toLowerCase() === 'true',
      brokerBase: env.TINKOFF_BASE || 'default',
    });
  }

  // Глубокая проверка связи с брокером: по ключу, потому что тратит запрос к API.
  if (path === '/health/broker') {
    if (!env.RELAY_KEY || !safeEqual(request.headers.get('X-Relay-Key'), env.RELAY_KEY)) return json({ error: 'forbidden' }, 403);
    try {
      const data = await tinkoffDirect(brokerEnv(env), 'UsersService/GetAccounts', {});
      return json({ ok: true, accounts: (data?.accounts || []).filter((a) => a.status === 'ACCOUNT_STATUS_OPEN').length });
    } catch (e) {
      return json({ ok: false, error: e.message }, 502);
    }
  }

  if (path.startsWith('/broker/')) return handleBroker(request, env, path.slice('/broker/'.length));

  // Заявки прямо из браузера (Firebase-токен владельца) — обработчики те же, что у воркера.
  if (path === '/order') return handleOrder(request, brokerEnv(env));
  if (path === '/order/config') return handleOrderConfig(request, brokerEnv(env));

  return json({ error: 'не найдено' }, 404);
}
