// relay/server.mjs — запуск посредника на любом российском сервере (VPS, Docker, домашний ПК).
//
//   NODE_EXTRA_CA_CERTS=./certs/russian_trusted_root_ca.pem \
//   TINKOFF_TRADE_TOKEN=... RELAY_KEY=... PORT=8080 node relay/server.mjs
//
// NODE_EXTRA_CA_CERTS — путь к корневому сертификату российского НУЦ (его скачивают с
// gosuslugi.ru/crt); Node читает его ПРИ СТАРТЕ процесса, поэтому задаётся именно переменной
// окружения. Сертификат нужен только этому процессу — системное хранилище не меняется.
//
// Запуск за HTTPS-прокси (nginx/caddy) обязателен: сервис сам TLS не терминирует.
import http from 'http';
import { handle } from './handler.mjs';

const PORT = Number(process.env.PORT) || 8080;

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const host = req.headers.host || 'localhost';
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await handle(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `внутренняя ошибка: ${e.message}` }));
  }
});

server.listen(PORT, () => console.log(`traderpro-relay слушает порт ${PORT}`));
