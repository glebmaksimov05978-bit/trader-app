// Проверка прохода робота «ГО фьючерсов» на подставной базе (npm run test:margin). Сеть и firebase-admin не нужны.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { runMargins } = await import(pathToFileURL(path.join(__dirname, 'futures/syncMargins.mjs')).href);
const tmpM = await import(pathToFileURL(path.join(__dirname, '../src/services/marketData/marginTrack.js')).href).catch(() => null);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// Таблица биржи в той же форме, что отдаёт ISS.
const SC = ['SECID', 'SHORTNAME', 'ASSETCODE', 'LASTTRADEDATE', 'MINSTEP', 'STEPPRICE', 'INITIALMARGIN', 'LOTVOLUME', 'BUYSELLFEE', 'SECTYPE', 'PREVSETTLEPRICE', 'LOWLIMIT', 'HIGHLIMIT'];
const table = async (margin) => {
  const M = tmpM || await import(pathToFileURL(path.join(__dirname, '../src/services/marketData/marginTrack.js')).href);
  const rows = [['MMZ6', 'MXI-12.26', 'MXI', '2026-12-17', 0.05, 0.5, margin, 1, 1.63, 'MM', 2466.6, 2330, 2602], ['MMH7', 'MXI-3.27', 'MXI', '2027-03-18', 0.05, 0.5, 3121, 1, 1.67, 'MM', 2541, 2388, 2694]];
  return M.parseFortsTable({ securities: { columns: SC, data: rows }, marketdata: { columns: ['SECID', 'LAST', 'SETTLEPRICE', 'UPDATETIME'], data: [['MMZ6', 2469.15, 2469.05, '20:26'], ['MMH7', 2544, 2544, '20:26']] } });
};

// Подставная база: коллекции в памяти, запросы where().where().get(), документы get/set.
function fakeDb(data) {
  const writes = [];
  const filterDocs = (name, conds) => (data[name] || []).filter((r) => conds.every(([f, op, v]) => (op === '==' ? r[f] === v : op === 'in' ? v.includes(r[f]) : true)));
  return {
    writes,
    collection(name) {
      const q = (conds) => ({ where: (f, op, v) => q([...conds, [f, op, v]]), get: async () => ({ docs: filterDocs(name, conds).map((r) => ({ id: r.id, data: () => r })) }) });
      return {
        ...q([]),
        doc: (id) => ({
          get: async () => ({ data: () => (data[`${name}:doc`] || {})[id] }),
          set: async (v) => { writes.push({ name, id, v }); data[`${name}:doc`] = { ...(data[`${name}:doc`] || {}), [id]: v }; },
        }),
      };
    },
  };
}

const UID = 'u1';
const base = () => ({
  radarItems: [
    { id: 'r1', uid: UID, ticker: 'MM', instrumentType: 'future' },
    { id: 'r2', uid: UID, ticker: 'SBER', instrumentType: 'stock' },
  ],
  trades: [{ id: 't1', uid: UID, ticker: 'MMZ6', instrumentType: 'future', status: 'open' }],
  paperTrades: [],
  'users:doc': { [UID]: { alertPrefs: {} } },
});
const quiet = () => {};
const T0 = Date.parse('2026-11-09T09:00:00Z');
let loads = 0;
const loader = (margin) => async () => { loads += 1; return table(margin); };
const noBroker = async () => new Map();
const sentTexts = [];
const send = async (t) => { sentTexts.push(t); return true; };

// 1. Первый проход: запоминаем, сообщений нет, состояние записано
let data = base(); let db = fakeDb(data);
let r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56), brokerMargins: noBroker, send, now: T0, log: quiet });
ok('первый проход: состояние записано в futuresMargin/<uid>, сообщений нет', r[0].saved === true && sentTexts.length === 0 && db.writes.length === 1 && db.writes[0].name === 'futuresMargin' && db.writes[0].id === UID);
const st1 = db.writes[0].v;
ok('в состоянии контракт MMZ6 (корень MM и позиция — один контракт), акция SBER не учтена', Object.keys(st1.items).join() === 'MMZ6' && st1.roots.MM === 'MMZ6' && st1.uid === UID && !!st1.at);

// 2. Слишком скоро — пропуск, биржу не трогаем
loads = 0; data['futuresMargin:doc'] = { [UID]: st1 };
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56), brokerMargins: noBroker, send, now: T0 + 20 * 60e3, log: quiet });
ok('через 20 минут — пропуск, таблицу биржи не грузим', r[0].skipped === 'свежее' && loads === 0 && db.writes.length === 1);
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56), brokerMargins: noBroker, send, now: T0 + 20 * 60e3, force: true, log: quiet });
ok('с --force проходит и вне часа', !r[0].skipped && loads === 1);

// 3. Через час ГО выросло на 5 % → одно сообщение, состояние обновлено
loads = 0; db = fakeDb(data); data['futuresMargin:doc'] = { [UID]: st1 }; sentTexts.length = 0;
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56 * 1.05), brokerMargins: noBroker, send, now: T0 + 3600e3, log: quiet });
ok('через час ГО +5 % → одно сообщение про MMZ6 и состояние сохранено', sentTexts.length === 1 && /MMZ6/.test(sentTexts[0]) && /\+5,0 %/.test(sentTexts[0]) && r[0].saved && db.writes.length === 1);
ok('в новом состоянии видно прошлое ГО', Math.abs(db.writes[0].v.items.MMZ6.prevBuy - 2750.56) < 1e-6);

// 4. Telegram не принял → состояние НЕ сохраняем (чтобы повторить)
db = fakeDb(data); data['futuresMargin:doc'] = { [UID]: st1 };
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56 * 1.2), brokerMargins: noBroker, send: async () => false, now: T0 + 3600e3, log: quiet, errLog: quiet });
ok('сообщение не ушло → состояние не записано, повтор на следующем проходе', r[0].saved === false && db.writes.length === 0);

// 5. Сухой прогон — ничего не пишет и не шлёт
db = fakeDb(data); data['futuresMargin:doc'] = { [UID]: st1 }; sentTexts.length = 0;
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56 * 1.2), brokerMargins: noBroker, send, now: T0 + 3600e3, dry: true, log: quiet });
ok('--dry: ни записи, ни сообщения', db.writes.length === 0 && sentTexts.length === 0);

// 6. Нет фьючерсов — биржу не трогаем
loads = 0; data = { ...base(), radarItems: [{ id: 'r2', uid: UID, ticker: 'SBER', instrumentType: 'stock' }], trades: [] }; db = fakeDb(data);
r = await runMargins({ db, uids: [UID], loadTable: loader(1), brokerMargins: noBroker, send, now: T0, log: quiet });
ok('в радаре только акции → ничего не делаем и биржу не грузим', r[0].skipped === 'нет фьючерсов' && loads === 0 && db.writes.length === 0);

// 7. Настройка «позиции» выключена, «радар» выключен → молчим, но состояние обновляем
data = base(); data['users:doc'][UID].alertPrefs = { marginNotifyRadar: false, marginNotifyOpen: false };
db = fakeDb(data); data['futuresMargin:doc'] = { [UID]: st1 }; sentTexts.length = 0;
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56 * 1.3), brokerMargins: noBroker, send, now: T0 + 3600e3, log: quiet });
ok('оба переключателя выключены → сообщения нет, а состояние (новое ГО) сохранено', sentTexts.length === 0 && db.writes.length === 1 && Math.abs(db.writes[0].v.items.MMZ6.buy - 2750.56 * 1.3) < 1e-6);

// 8. Данные Т-Банка: появились → источник меняется, сообщений нет; лонг и шорт раздельно
data = base(); db = fakeDb(data); data['futuresMargin:doc'] = { [UID]: st1 }; sentTexts.length = 0;
r = await runMargins({ db, uids: [UID], loadTable: loader(2750.56), brokerMargins: async () => new Map([['MMZ6', { buy: 2900, sell: 3300 }]]), send, now: T0 + 3600e3, log: quiet });
ok('данные Т-Банка: источник tbank, лонг/шорт раздельно, ложного «изменения» нет', sentTexts.length === 0 && db.writes[0].v.items.MMZ6.src === 'tbank' && db.writes[0].v.items.MMZ6.sell === 3300);

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки прошли');
process.exitCode = fails ? 1 : 0;
