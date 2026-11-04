// scripts/tbankProbe.mjs
//
// Одноразовая безопасная проверка API Т-Банка на вашем компьютере. ТОЛЬКО ЧТЕНИЕ: счета, операции за 90 дней,
// портфель, ГО фьючерсов. Заявок не отправляет. Токен берётся из переменной окружения TBANK_TOKEN и нигде не
// сохраняется и не печатается; идентификаторы счетов в файлах заменены на acc1, acc2…
//
// Зачем: подогнать автоимпорт истории сделок по API под настоящие ответы (лоты или штуки, как приходят комиссии и
// сделки по фьючерсам) и проверить, что Т-Банк отдаёт ГО на покупку и продажу.
//
// Запуск (PowerShell, из папки проекта; токен достаточно «только чтение»):
//   $env:TBANK_TOKEN = "<ваш токен>"; node scripts/tbankProbe.mjs
// Результат: папка scripts/_probe/ (в git не попадает) — tbank_ops_sample.json, tbank_portfolio.json,
// tbank_futures_margin.json. Эти файлы можно показать ассистенту: токена в них нет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.TBANK_TOKEN;
if (!TOKEN) {
  console.log('Нет токена. Запуск:\n  $env:TBANK_TOKEN = "<ваш токен>"; node scripts/tbankProbe.mjs');
  process.exit(1);
}
const BASE = 'https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '_probe');
fs.mkdirSync(OUT, { recursive: true });

async function call(method, body = {}) {
  const res = await fetch(BASE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method}: ${res.status} ${json.message || ''}`.trim());
  return json;
}
const q = (v) => (v ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : null);
const save = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2), 'utf8');

const accounts = (await call('UsersService/GetAccounts')).accounts || [];
const open = accounts.filter((a) => a.status !== 'ACCOUNT_STATUS_CLOSED');
const label = new Map(open.map((a, i) => [a.id, `acc${i + 1}`]));
console.log(`Счетов: ${open.length} (${open.map((a) => `${label.get(a.id)}: ${a.type || '?'}`).join(', ')})`);

// --- операции за 90 дней ---
const to = new Date();
const from = new Date(to.getTime() - 90 * 86400000);
const ops = [];
for (const acc of open) {
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const r = await call('OperationsService/GetOperationsByCursor', {
      accountId: acc.id, from: from.toISOString(), to: to.toISOString(), limit: 200, cursor,
      state: 'OPERATION_STATE_EXECUTED', withoutCommissions: false, withoutTrades: false, withoutOvernights: true,
    });
    for (const it of r.items || []) {
      const { brokerAccountId, cursor: _c, ...rest } = it;
      ops.push({ account: label.get(acc.id), ...rest });
    }
    if (!r.hasNext) break;
    cursor = r.nextCursor;
  }
}
const byType = {};
for (const o of ops) byType[`${o.type} / ${o.instrumentType || o.instrumentKind || '?'}`] = (byType[`${o.type} / ${o.instrumentType || o.instrumentKind || '?'}`] || 0) + 1;
console.log('Операции за 90 дней:', ops.length);
console.log(Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v}\t${k}`).join('\n'));
// В файл — сделки (покупка/продажа) целиком и немного прочих (комиссии, экспирация), чтобы видеть форму.
const trades = ops.filter((o) => /_(BUY|SELL)(_MARGIN)?$/.test(o.type));
const other = ops.filter((o) => !/_(BUY|SELL)(_MARGIN)?$/.test(o.type)).slice(0, 25);
save('tbank_ops_sample.json', { period: { from: from.toISOString(), to: to.toISOString() }, tradeCount: trades.length, trades: trades.slice(0, 150), otherSample: other });

// --- портфель ---
const portfolio = [];
for (const acc of open) {
  try {
    const p = await call('OperationsService/GetPortfolio', { accountId: acc.id });
    for (const x of p.positions || []) {
      portfolio.push({
        account: label.get(acc.id), ticker: x.ticker, instrumentType: x.instrumentType, quantity: q(x.quantity), quantityLots: q(x.quantityLots),
        averagePositionPrice: q(x.averagePositionPrice), currentPrice: q(x.currentPrice), expectedYield: q(x.expectedYield),
        varMargin: q(x.varMargin), instrumentUid: x.instrumentUid,
      });
    }
  } catch (e) { console.log(`Портфель ${label.get(acc.id)}: ${e.message}`); }
}
save('tbank_portfolio.json', portfolio);
console.log(`Позиций в портфелях: ${portfolio.length}`);

// --- ГО фьючерсов: FutureBy и GetFuturesMargin ---
const wantedTickers = new Set(['SRZ6', 'RNZ6']);
for (const o of ops) if ((o.instrumentType || '') === 'futures' && o.ticker) wantedTickers.add(o.ticker);
for (const x of portfolio) if (x.instrumentType === 'futures' && x.ticker) wantedTickers.add(x.ticker);
const margins = [];
for (const ticker of [...wantedTickers].slice(0, 8)) {
  const row = { ticker };
  try {
    const f = (await call('InstrumentsService/FutureBy', { idType: 'INSTRUMENT_ID_TYPE_TICKER', classCode: 'SPBFUT', id: ticker })).instrument;
    if (!f) { row.error = 'FutureBy: контракт не найден'; margins.push(row); continue; }
    row.futureBy = {
      lot: f.lot, minPriceIncrement: q(f.minPriceIncrement), minPriceIncrementAmount: q(f.minPriceIncrementAmount),
      initialMarginOnBuy: q(f.initialMarginOnBuy), initialMarginOnSell: q(f.initialMarginOnSell),
      dlongClient: q(f.dlongClient), dshortClient: q(f.dshortClient), shortEnabled: f.shortEnabledFlag, buyAvailable: f.buyAvailableFlag, sellAvailable: f.sellAvailableFlag,
    };
    const m = await call('InstrumentsService/GetFuturesMargin', { instrumentId: f.uid });
    row.getFuturesMargin = { initialMarginOnBuy: q(m.initialMarginOnBuy), initialMarginOnSell: q(m.initialMarginOnSell), minPriceIncrement: q(m.minPriceIncrement), minPriceIncrementAmount: q(m.minPriceIncrementAmount) };
  } catch (e) { row.error = e.message; }
  margins.push(row);
}
save('tbank_futures_margin.json', margins);
for (const m of margins) {
  console.log(`${m.ticker}: FutureBy ГО лонг/шорт ${m.futureBy?.initialMarginOnBuy ?? '—'} / ${m.futureBy?.initialMarginOnSell ?? '—'}; GetFuturesMargin ${m.getFuturesMargin?.initialMarginOnBuy ?? '—'} / ${m.getFuturesMargin?.initialMarginOnSell ?? '—'}${m.error ? ` (${m.error})` : ''}`);
}
console.log(`\nГотово. Файлы в ${OUT}. Токен нигде не сохранён.`);
