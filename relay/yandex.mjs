// relay/yandex.mjs — обёртка для Yandex Cloud Functions (HTTP-интеграция).
//
// Точка входа функции: yandex.handler. Формат события — как у «HTTP-вызова функции»: в event
// лежат httpMethod, path/url, headers, queryStringParameters, body и isBase64Encoded; ответ —
// объект {statusCode, headers, body}. Логика — в handler.mjs, здесь только перевод форматов.
//
// Переменные окружения функции (см. relay/README.md): TINKOFF_TRADE_TOKEN, RELAY_KEY,
// NODE_EXTRA_CA_CERTS (путь к сертификату внутри архива функции), TRADING_DISABLED (стоп-кран).
import { handle } from './handler.mjs';

export async function handler(event) {
  const method = event.httpMethod || 'GET';
  const headers = event.headers || {};
  const host = headers.Host || headers.host || 'localhost';
  // Яндекс не принимает путь после идентификатора функции («.../<id>/health» → «invalid functionID»),
  // поэтому нужный маршрут передаётся параметром: ?integration=raw&route=/health.
  // Служебные параметры (integration, route) дальше не пробрасываются.
  const params = { ...(event.queryStringParameters || {}) };
  const route = params.route;
  delete params.route;
  delete params.integration;
  const rest = new URLSearchParams(params).toString();
  const qs = rest ? `?${rest}` : '';
  const path = route || event.path || event.url || '/';
  const raw = event.body == null ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;

  const request = new Request(`https://${host}${path}${qs}`, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : raw,
  });
  const response = await handle(request, process.env);
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
    isBase64Encoded: false,
  };
}
