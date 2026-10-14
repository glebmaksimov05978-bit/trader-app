// Проверка робота отметок действий на поддельном посреднике (npm run test:syncactions).
// Поднимается локальный HTTP-сервер, который отвечает как посредник к Т-Банку; настоящая сеть и
// настоящий счёт не нужны. Проверяется весь путь: адрес посредника → позиции → баланс по тикеру →
// сверка с бумажными сделками.
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { loadBalances } = await import(pathToFileURL(path.join(__dirname, 'syncActions.mjs')).href);
const { reconcileWithBroker } = await import(pathToFileURL(path.join(__dirname, '../../src/services/analytics/actionMatch.js')).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const KEY = 'test-relay-key';
const calls = [];
// Два счёта: на первом 10 акций SBER и фьючерс BRX6 в шорт (−2), на втором ещё 5 акций SBER.
const POSITIONS = {
  acc1: { securities: [{ figi: 'FIGI_SBER', instrumentUid: 'uid-sber', balance: 10 }], futures: [{ figi: 'FIGI_BRX6', instrumentUid: 'uid-brx6', balance: -2 }] },
  acc2: { securities: [{ figi: 'FIGI_SBER', instrumentUid: 'uid-sber', balance: 5 }], futures: [] },
};
const INSTRUMENTS = {
  SBER: { figi: 'FIGI_SBER', uid: 'uid-sber', ticker: 'SBER', name: 'Сбербанк', lot: 10 },
  BRX6: { figi: 'FIGI_BRX6', uid: 'uid-brx6', ticker: 'BRX6', name: 'Brent', lot: 1 },
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, key: req.headers['x-relay-key'], body });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-relay-key'] !== KEY) return send(403, { error: 'forbidden' });
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/broker/UsersService/GetAccounts') {
      return send(200, { accounts: [{ id: 'acc1', name: 'Брокерский', status: 'ACCOUNT_STATUS_OPEN' }, { id: 'acc2', name: 'ИИС', status: 'ACCOUNT_STATUS_OPEN' }, { id: 'acc3', name: 'Закрыт', status: 'ACCOUNT_STATUS_CLOSED' }] });
    }
    if (req.url === '/broker/OperationsService/GetPositions') return send(200, POSITIONS[data.accountId] || { securities: [], futures: [] });
    if (req.url === '/broker/InstrumentsService/FindInstrument') {
      const hit = INSTRUMENTS[String(data.query).toUpperCase()];
      return send(200, { instruments: hit ? [hit] : [] });
    }
    return send(404, { error: 'нет такого метода' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { RELAY_URL: base, RELAY_KEY: KEY };

try {
  const bal = await loadBalances(env, [{ ticker: 'SBER', type: 'stock' }, { ticker: 'BRX6', type: 'future' }, { ticker: 'NOPE', type: 'stock' }]);
  ok('акции суммируются по всем счетам: 10 + 5 = 15', bal.SBER === 15);
  ok('фьючерс в шорт — отрицательный баланс', bal.BRX6 === -2);
  ok('неизвестный тикер пропускается, а не роняет робота', !('NOPE' in bal));
  ok('закрытый счёт не опрашивается', !calls.some((c) => c.body.includes('acc3')));
  ok('ключ посредника передан в каждом вызове', calls.every((c) => c.key === KEY));
  ok('используются только методы чтения', calls.every((c) => /GetAccounts|GetPositions|FindInstrument/.test(c.url)));
  ok('заявки не отправляются', !calls.some((c) => /PostOrder/.test(c.url)));

  // Полный цикл: бумажные сделки + позиции → события
  const paper = [
    { id: 'p1', ticker: 'SBER', direction: 'long', status: 'open', entryStrategyName: 'Пробой' },
    { id: 'p2', ticker: 'BRX6', direction: 'short', status: 'open', entryStrategyName: 'Откат' },
  ];
  const r = reconcileWithBroker({ paperTrades: paper, balances: bal, journalTrades: [] });
  ok('лонг по SBER: вошёл на 15', r.events.find((e) => e.paperId === 'p1')?.kind === 'entered' && r.events.find((e) => e.paperId === 'p1').qty === 15);
  ok('шорт по BRX6: вошёл на 2', r.events.find((e) => e.paperId === 'p2')?.kind === 'entered' && r.events.find((e) => e.paperId === 'p2').qty === 2);

  // Неверный ключ — ошибка, а не молчаливо пустой ответ
  let failed = false;
  try { await loadBalances({ RELAY_URL: base, RELAY_KEY: 'wrong' }, [{ ticker: 'SBER', type: 'stock' }]); } catch { failed = true; }
  ok('неверный ключ посредника — ошибка', failed);

  // Посредник недоступен — ошибка
  failed = false;
  try { await loadBalances({ RELAY_URL: 'http://127.0.0.1:1', RELAY_KEY: KEY }, [{ ticker: 'SBER', type: 'stock' }]); } catch { failed = true; }
  ok('посредник недоступен — ошибка (робот пропустит проход)', failed);
} finally {
  server.close();
}

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки робота отметок прошли ✓');
