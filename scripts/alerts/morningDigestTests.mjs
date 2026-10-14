// Проверка утренней сводки: когда слать и что в ней (npm run test:digest).
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildDigest, shouldSendDigest, parseRobotCheck, moscowParts } = await import(pathToFileURL(path.join(__dirname, 'morningDigest.mjs')).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const strip = (t) => String(t).replace(/<[^>]+>/g, '');

// Москва = UTC+3. 2026-10-14 08:05 МСК = 05:05 UTC.
const T0805 = Date.parse('2026-10-14T05:05:00Z');
const T0759 = Date.parse('2026-10-14T04:59:00Z');
const T1210 = Date.parse('2026-10-14T09:10:00Z');
const T2330 = Date.parse('2026-10-13T20:30:00Z'); // 23:30 МСК 13-го

// ---- время ----
ok('московская дата и час', moscowParts(T0805).date === '2026-10-14' && moscowParts(T0805).hour === 8);
ok('в 23:30 МСК по UTC ещё 13-е, по Москве — 13-е 23:30', moscowParts(T2330).date === '2026-10-13' && moscowParts(T2330).hour === 23);
ok('через полночь по UTC в Москве уже новый день', moscowParts(Date.parse('2026-10-13T21:30:00Z')).date === '2026-10-14');

// ---- когда слать ----
ok('в 8:05 — слать', shouldSendDigest({ prefs: {}, nowMs: T0805 }).send === true);
ok('в 7:59 — рано', shouldSendDigest({ prefs: {}, nowMs: T0759 }).send === false);
ok('в 12:10 — утро прошло', shouldSendDigest({ prefs: {}, nowMs: T1210 }).send === false);
ok('сегодня уже слали', shouldSendDigest({ prefs: {}, digestSentOn: '2026-10-14', nowMs: T0805 }).send === false);
ok('вчера слали — сегодня можно', shouldSendDigest({ prefs: {}, digestSentOn: '2026-10-13', nowMs: T0805 }).send === true);
ok('выключена в Настройках', shouldSendDigest({ prefs: { morningDigest: false }, nowMs: T0805 }).send === false);
ok('свой час: с 9 — в 8:05 рано', shouldSendDigest({ prefs: { digestHour: 9 }, nowMs: T0805 }).send === false);
ok('свой час: с 6 — в 7:59 уже можно', shouldSendDigest({ prefs: { digestHour: 6 }, nowMs: T0759 }).send === true);
ok('force игнорирует час', shouldSendDigest({ prefs: {}, nowMs: T1210, force: true }).send === true);
ok('force не включает выключенную', shouldSendDigest({ prefs: { morningDigest: false }, nowMs: T1210, force: true }).send === false);

// ---- разбор проверки радара ----
const rc = parseRobotCheck('«Пробой»: условия не сошлись на закрытой свече 2026-10-13: лонг 5/6 (83%), шорт 2/6 (33%), нужно 100%');
ok('разбор: лучший счёт 5 из 6, нужно 100%', rc && rc.passed === 5 && rc.total === 6 && rc.pct === 83 && rc.need === 100);
ok('разбор: шорт лучше', parseRobotCheck('лонг 1/6 (17%), шорт 4/6 (67%), нужно 80%').passed === 4);
ok('разбор мусора → null', parseRobotCheck('открыл лонг') === null && parseRobotCheck(null) === null);

// ---- содержимое ----
const profile = {
  depositSize: 100000,
  strategies: [{ id: 'A', name: 'Пробой', horizon: 'short', timeframe: 'H1' }],
};
const trades = [
  { id: 't1', ticker: 'sber', direction: 'long', status: 'open', entryPrice: 300, stopLoss: 294, volume: 10, lot: 10, openedAt: '2026-10-12T08:00:00Z', entryStrategyName: 'Пробой' },
  { id: 't2', ticker: 'GAZP', direction: 'long', status: 'closed', pnl: -300, closedAt: '2026-10-13T12:00:00Z' },
  { id: 't3', ticker: 'LKOH', direction: 'long', status: 'closed', pnl: 100, closedAt: '2026-10-13T14:00:00Z' },
  { id: 't4', ticker: 'VTBR', direction: 'long', status: 'closed', pnl: 5000, closedAt: '2026-10-10T14:00:00Z' },
];
const paper = [
  { id: 'p1', ticker: 'GAZP', direction: 'short', status: 'open', entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1' },
  { id: 'p2', ticker: 'MGNT', direction: 'long', status: 'open', entryStrategyId: 'A', entryStrategyName: 'Пробой', decisions: [{ at: '2026-10-14T01:00:00Z', action: 'entered' }] },
  { id: 'p3', ticker: 'YDEX', direction: 'long', status: 'closed', pnl: 40, closedAt: '2026-10-13T09:00:00Z' },
];
const radar = [
  { id: 'r1', ticker: 'LKOH', strategyId: 'A', robotCheck: { text: 'лонг 5/6 (83%), шорт 2/6 (33%), нужно 100%' } },
  { id: 'r2', ticker: 'ROSN', robotCheck: { text: 'лонг 1/6 (17%), шорт 0/6 (0%), нужно 100%' } },
  { id: 'r3', ticker: 'NVTK', robotCheck: { text: 'лонг 6/6 (100%), шорт 0/6 (0%), нужно 100%' } },
];
const { text, payload } = buildDigest({ profile, trades, paper, radar, nowMs: T0805 });
const t = strip(text);

ok('открытая позиция с тикером в верхнем регистре и сроком 2 дня', payload.open.length === 1 && payload.open[0].ticker === 'SBER' && payload.open[0].days === 2);
ok('риск: 6 × лот 10 × 10 = 600 ₽ = 0,6% депозита', payload.risk.riskRub === 600 && Math.abs(payload.risk.riskPct - 0.6) < 1e-9);
ok('бумажные: две открытые, подпись «краткосрок · Ч1»', payload.paper.length === 2 && payload.paper[0].caption === 'краткосрок · Ч1');
ok('ждёт отметки одна (вторая уже отмечена)', payload.pendingDecisions === 1);
ok('близко к входу: только LKOH (83%), ROSN далеко, NVTK уже сошёлся', payload.near.length === 1 && payload.near[0].ticker === 'LKOH' && payload.near[0].strategy === 'Пробой');
ok('вчера по Москве: два реальных и одна бумажная = 3 сделки, итог −160', payload.yesterday.count === 3 && payload.yesterday.pnl === -160);
ok('сделка 10 октября во «вчера» не попала', payload.yesterday.pnl < 1000);
ok('в тексте: заголовок, позиция, риск, вчера', /Утренняя сводка — среда, 14 октября/.test(t) && /SBER лонг/.test(t) && /Риск открытых позиций: 600 ₽/.test(t) && /Вчера: закрыто 3, итог −160 ₽/.test(t));
ok('пустой аккаунт — слать нечего', buildDigest({ profile: {}, trades: [], paper: [], radar: [], nowMs: T0805 }).text === null);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки утренней сводки прошли ✓');
