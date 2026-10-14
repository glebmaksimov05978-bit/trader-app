// Проверка сверки бумажных сделок с позициями у брокера и журнала решений (npm run test:actions).
import {
  heldInDirection, reconcileWithBroker, eventToDecision, describeEvent, summarizeDecisions, statusLine,
} from '../src/services/analytics/actionMatch.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const NOW = Date.parse('2026-10-14T12:00:00Z');
const P = (o) => ({ id: 'p1', ticker: 'SBER', direction: 'long', status: 'open', entryStrategyName: 'Пробой', ...o });

// --- позиция в сторону сделки ---
ok('лонг + положительный баланс → держит', heldInDirection(10, 'long') === 10);
ok('лонг + отрицательный баланс → 0 (в другую сторону)', heldInDirection(-10, 'long') === 0);
ok('шорт + отрицательный баланс → держит', heldInDirection(-3, 'short') === 3);
ok('нет данных → 0', heldInDirection(undefined, 'long') === 0 && heldInDirection('x', 'short') === 0);

// --- вход ---
let r = reconcileWithBroker({ paperTrades: [P()], balances: { SBER: 10 }, nowMs: NOW });
ok('появилась позиция → событие «вошёл»', r.events.length === 1 && r.events[0].kind === 'entered' && r.events[0].qty === 10 && !r.events[0].ambiguous);
ok('наблюдение переходит в «in» с объёмом', r.patches.p1.state === 'in' && r.patches.p1.lastQty === 10);
r = reconcileWithBroker({ paperTrades: [P()], balances: {}, nowMs: NOW });
ok('позиции нет → событий нет и патчей нет', r.events.length === 0 && Object.keys(r.patches).length === 0);
r = reconcileWithBroker({ paperTrades: [P()], balances: { SBER: -5 }, nowMs: NOW });
ok('позиция в обратную сторону не считается входом по лонговому сигналу', r.events.length === 0);

// --- уже учтено в журнале ---
r = reconcileWithBroker({ paperTrades: [P()], balances: { SBER: 10 }, journalTrades: [{ ticker: 'sber', direction: 'long', status: 'open' }], nowMs: NOW });
ok('сделка по тикеру уже в журнале → отметок не создаём', r.events.length === 0 && r.patches.p1.state === 'journal');
r = reconcileWithBroker({ paperTrades: [P()], balances: { SBER: 10 }, journalTrades: [{ ticker: 'SBER', direction: 'short', status: 'open' }], nowMs: NOW });
ok('в журнале шорт, сигнал лонг → вход определяется', r.events.length === 1);
r = reconcileWithBroker({ paperTrades: [P()], balances: { SBER: 10 }, journalTrades: [{ ticker: 'SBER', direction: 'long', status: 'closed' }], nowMs: NOW });
ok('закрытая сделка в журнале не мешает', r.events.length === 1);

// --- частичная фиксация и выход ---
const inTrade = P({ brokerWatch: { state: 'in', lastQty: 10, maxQty: 10 } });
r = reconcileWithBroker({ paperTrades: [inTrade], balances: { SBER: 4 }, nowMs: NOW });
ok('позиция уменьшилась 10 → 4: частичная фиксация на 6', r.events[0].kind === 'partial' && r.events[0].qty === 6 && r.events[0].held === 4);
ok('в наблюдении запомнили 4', r.patches.p1.lastQty === 4 && r.patches.p1.state === 'in');
r = reconcileWithBroker({ paperTrades: [inTrade], balances: {}, nowMs: NOW });
ok('позиция исчезла: «вышел», наблюдение → out', r.events[0].kind === 'closed' && r.events[0].qty === 10 && r.patches.p1.state === 'out');
r = reconcileWithBroker({ paperTrades: [inTrade], balances: { SBER: 10 }, nowMs: NOW });
ok('ничего не изменилось → тишина', r.events.length === 0 && Object.keys(r.patches).length === 0);
r = reconcileWithBroker({ paperTrades: [inTrade], balances: { SBER: 15 }, nowMs: NOW });
ok('докупили: события нет, объём обновлён', r.events.length === 0 && r.patches.p1.lastQty === 15 && r.patches.p1.maxQty === 15);

// --- повторный вход после выхода ---
const outTrade = P({ brokerWatch: { state: 'out', lastQty: 0, maxQty: 10 } });
r = reconcileWithBroker({ paperTrades: [outTrade], balances: { SBER: 3 }, nowMs: NOW });
ok('после выхода новая позиция — снова «вошёл»', r.events.length === 1 && r.events[0].kind === 'entered');

// --- неоднозначность ---
const two = [P({ id: 'pa', entryStrategyName: 'Пробой' }), P({ id: 'pb', entryStrategyName: 'Откат' })];
r = reconcileWithBroker({ paperTrades: two, balances: { SBER: 10 }, nowMs: NOW });
ok('две стратегии по одному тикеру: одно неоднозначное событие', r.events.length === 1 && r.events[0].ambiguous === true && r.events[0].candidates.length === 2);
ok('обе сделки помечены «ambiguous» — повторного вопроса не будет', r.patches.pa.state === 'ambiguous' && r.patches.pb.state === 'ambiguous');
r = reconcileWithBroker({ paperTrades: two.map((t) => ({ ...t, brokerWatch: { state: 'ambiguous', lastQty: 10 } })), balances: { SBER: 10 }, nowMs: NOW });
ok('повторный проход: не переспрашиваем', r.events.length === 0);
r = reconcileWithBroker({ paperTrades: two.map((t) => ({ ...t, brokerWatch: { state: 'ambiguous', lastQty: 10 } })), balances: {}, nowMs: NOW });
ok('позиция пропала — состояние сбрасывается', r.patches.pa.state === 'none' && r.patches.pb.state === 'none');
const diffDir = [P({ id: 'pa' }), P({ id: 'pb', direction: 'short', entryStrategyName: 'Откат' })];
r = reconcileWithBroker({ paperTrades: diffDir, balances: { SBER: 10 }, nowMs: NOW });
ok('лонг и шорт по одному тикеру — не конфликт: вход приписывается лонгу', r.events.length === 1 && r.events[0].paperId === 'pa' && !r.events[0].ambiguous);
const declined = [P({ id: 'pa', brokerWatch: { state: 'in', lastQty: 10 } }), P({ id: 'pb', brokerWatch: { state: 'declined', lastQty: 10 } })];
r = reconcileWithBroker({ paperTrades: declined, balances: { SBER: 10 }, nowMs: NOW });
ok('«declined» не порождает событий', r.events.length === 0);

// --- система вышла, а вы ещё в позиции ---
const sysClosed = P({ status: 'closed', closedAt: '2026-10-13T10:00:00Z', brokerWatch: { state: 'in', lastQty: 10 } });
r = reconcileWithBroker({ paperTrades: [sysClosed], balances: { SBER: 10 }, nowMs: NOW });
ok('закрыта роботом, вы в позиции → один раз напоминаем', r.events.length === 1 && r.events[0].kind === 'system_exit_still_holding' && r.patches.p1.notifiedExit === true);
r = reconcileWithBroker({ paperTrades: [{ ...sysClosed, brokerWatch: { state: 'in', lastQty: 10, notifiedExit: true } }], balances: { SBER: 10 }, nowMs: NOW });
ok('повторно не напоминаем', r.events.length === 0);
r = reconcileWithBroker({ paperTrades: [{ ...sysClosed, closedAt: '2026-09-01T10:00:00Z' }], balances: { SBER: 10 }, nowMs: NOW });
ok('давно закрытую не трогаем', r.events.length === 0);
r = reconcileWithBroker({ paperTrades: [sysClosed], balances: {}, nowMs: NOW });
ok('закрыта и вы вышли — тихо, наблюдение → out', r.events.length === 0 && r.patches.p1.state === 'out');
r = reconcileWithBroker({ paperTrades: [P({ status: 'closed', closedAt: '2026-10-13T10:00:00Z' })], balances: { SBER: 10 }, nowMs: NOW });
ok('закрытая без наблюдения за позицией не создаёт «вошёл»', r.events.length === 0);

// --- уже отмеченное вручную ---
r = reconcileWithBroker({ paperTrades: [P({ decisions: [{ at: '2026-10-14T10:00:00Z', action: 'entered', via: 'telegram' }] })], balances: { SBER: 10 }, nowMs: NOW });
ok('вход отмечен вручную → повторного события нет, но слежение начато', r.events.length === 0 && r.patches.p1.state === 'in');
r = reconcileWithBroker({ paperTrades: [P({ decisions: [{ at: '2026-10-14T10:00:00Z', action: 'not_this', via: 'app' }] })], balances: { SBER: 10 }, nowMs: NOW });
ok('«это не по сигналу» → больше не гадаем', r.events.length === 0 && r.patches.p1.state === 'declined');
r = reconcileWithBroker({ paperTrades: [P({ decisions: [{ at: '2026-10-14T10:00:00Z', action: 'entered', via: 'broker' }] })], balances: { SBER: 10 }, nowMs: NOW });
ok('автоопределённый вход (без слежения) не блокирует новое определение', r.events.length === 1);

// --- запись в журнал решений ---
const dEnter = eventToDecision({ kind: 'entered', qty: 10 }, '2026-10-14T10:00:00Z');
ok('«вошёл» → запись с via=broker', dEnter.action === 'entered' && dEnter.via === 'broker' && dEnter.qty === 10);
ok('частичная → fixed_partial', eventToDecision({ kind: 'partial', qty: 2 }).action === 'fixed_partial');
ok('выход → closed_full', eventToDecision({ kind: 'closed', qty: 2 }).action === 'closed_full');
ok('напоминание о позиции не записывается как решение', eventToDecision({ kind: 'system_exit_still_holding' }) === null);
ok('неоднозначный вход помечен', eventToDecision({ kind: 'entered', ambiguous: true, qty: 1 }).ambiguous === true);

// --- тексты ---
ok('текст входа', /Вижу в Т-Банке вашу позицию SBER \(лонг, 10 шт\.\)/.test(describeEvent({ kind: 'entered', ticker: 'SBER', direction: 'long', qty: 10, strategy: 'Пробой' })));
ok('текст неоднозначности перечисляет стратегии', /«Пробой», «Откат»/.test(describeEvent({ kind: 'entered', ticker: 'SBER', direction: 'long', qty: 10, ambiguous: true, candidates: [{ strategy: 'Пробой' }, { strategy: 'Откат' }] })));
ok('текст частичной фиксации', /уменьшилась на 6 шт\. \(осталось 4 шт\.\)/.test(describeEvent({ kind: 'partial', ticker: 'SBER', qty: 6, held: 4 })));

// --- свод решений ---
const d = P({ decisions: [
  { at: '2026-10-14T10:00:00Z', action: 'entered', via: 'app' },
  { at: '2026-10-14T11:00:00Z', action: 'fixed_partial', via: 'telegram' },
] });
const sm = summarizeDecisions(d);
ok('свод: вошёл, одна фиксация, не закрыл', sm.entered && sm.partials === 1 && !sm.closed && !sm.skipped);
ok('подпись статуса', statusLine(d) === 'Вы: вошли · снято частями 1');
ok('пропуск с причиной', statusLine(P({ decisions: [{ at: '2026-10-14T10:00:00Z', action: 'skipped', reason: 'Не успел' }] })) === 'Вы: пропустили — Не успел');
ok('вошёл после пропуска — пропуск снимается', summarizeDecisions(P({ decisions: [
  { at: '2026-10-14T10:00:00Z', action: 'skipped', reason: 'x' }, { at: '2026-10-14T10:05:00Z', action: 'entered' }] })).skipped === false);
ok('«не по этому сигналу» сбрасывает вход', summarizeDecisions(P({ decisions: [
  { at: '2026-10-14T10:00:00Z', action: 'entered', via: 'broker' }, { at: '2026-10-14T10:05:00Z', action: 'not_this' }] })).entered === false);
ok('автоопределение видно', summarizeDecisions(P({ decisions: [{ at: '2026-10-14T10:00:00Z', action: 'entered', via: 'broker' }] })).auto === true);
ok('порядок решений не важен: сортируется по времени', summarizeDecisions(P({ decisions: [
  { at: '2026-10-14T10:05:00Z', action: 'closed_full' }, { at: '2026-10-14T10:00:00Z', action: 'entered' }] })).closed === true);
ok('нет решений — подписи нет', statusLine(P()) === null);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки отметок действий прошли ✓');
