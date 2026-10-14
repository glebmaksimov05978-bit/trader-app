// Проверка отслеживания ожидающих заявок (npm run test:pending). Сеть и база не нужны.
import { planPendingUpdate, planPendingClose, reconcilePendingTrades } from '../src/services/pendingOrders.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const now = new Date('2026-10-14T12:00:00Z');
const pend = { id: 'T1', ticker: 'VTBR', direction: 'long', status: 'pending', volume: 5, lot: 1, entryPrice: 70, commissionRate: 0.0005, pendingOrder: { orderId: 'o1', accountId: 'a1' } };

ok('NEW — всё ещё ждёт, ничего не меняем', planPendingUpdate(pend, { status: 'EXECUTION_REPORT_STATUS_NEW', lotsExecuted: 0 }, now) === null);

let r = planPendingUpdate(pend, { status: 'EXECUTION_REPORT_STATUS_FILL', lotsExecuted: 5, averagePrice: 55.9 }, now);
ok('исполнена: статус open, цена и объём с брокера', r.patch.status === 'open' && r.patch.entryPrice === 55.9 && r.patch.volume === 5 && r.patch.remainingVolume === 5);
ok('исполнена: ступень входа с номером заявки', r.patch.legs[0].type === 'open' && r.patch.legs[0].dealNumber === 'o1' && r.patch.legs[0].price === 55.9);
ok('исполнена: комиссия пересчитана на реальную цену', r.patch.commission === Math.round(55.9 * 5 * 1 * 0.0005 * 2));

r = planPendingUpdate(pend, { status: 'EXECUTION_REPORT_STATUS_PARTIALLYFILL', lotsExecuted: 2, averagePrice: 56 }, now);
ok('частично: остаётся ждать, запоминаем сколько исполнено', r.patch.status === undefined && r.patch.pendingOrder.filledLots === 2);
ok('частично, но без новых лотов — ничего', planPendingUpdate({ ...pend, pendingOrder: { ...pend.pendingOrder, filledLots: 2 } }, { status: 'EXECUTION_REPORT_STATUS_PARTIALLYFILL', lotsExecuted: 2 }, now) === null);

r = planPendingUpdate(pend, { status: 'EXECUTION_REPORT_STATUS_CANCELLED', lotsExecuted: 0 }, now);
ok('снята без исполнения: статус cancelled', r.patch.status === 'cancelled');
r = planPendingUpdate(pend, { status: 'EXECUTION_REPORT_STATUS_CANCELLED', lotsExecuted: 3, averagePrice: 56 }, now);
ok('снята, но 3 лота успели исполниться: открываем на 3', r.patch.status === 'open' && r.patch.volume === 3);
r = planPendingUpdate(pend, { status: 'EXECUTION_REPORT_STATUS_REJECTED', lotsExecuted: 0 }, now);
ok('отклонена: cancelled', r.patch.status === 'cancelled');
ok('нет ответа брокера — не трогаем', planPendingUpdate(pend, null, now) === null);

// закрывающая заявка
const closing = { id: 'T2', ticker: 'VTBR', status: 'open', pendingClose: { orderId: 'c1', accountId: 'a1' } };
ok('закрытие ещё ждёт', planPendingClose(closing, { status: 'EXECUTION_REPORT_STATUS_NEW', lotsExecuted: 0 }) === null);
const pc = planPendingClose(closing, { status: 'EXECUTION_REPORT_STATUS_FILL', lotsExecuted: 4, averagePrice: 57 });
ok('закрытие исполнено: qty 4 по 57', pc.qty === 4 && pc.price === 57 && pc.clear === true);
ok('закрытие снято — только убрать отметку', planPendingClose(closing, { status: 'EXECUTION_REPORT_STATUS_CANCELLED', lotsExecuted: 0 }).clear === true);

// обход
const updates = []; const closes = [];
const trades = [pend, { ...closing }, { id: 'T3', status: 'open', ticker: 'X' }, { id: 'T4', status: 'pending', ticker: 'BAD', pendingOrder: { orderId: 'bad', accountId: 'a' } }];
const res = await reconcilePendingTrades({
  trades,
  fetchState: async ({ orderId }) => {
    if (orderId === 'o1') return { status: 'EXECUTION_REPORT_STATUS_FILL', lotsExecuted: 5, averagePrice: 56 };
    if (orderId === 'c1') return { status: 'EXECUTION_REPORT_STATUS_FILL', lotsExecuted: 4, averagePrice: 57 };
    throw new Error('нет такой заявки');
  },
  updateTrade: async (id, patch) => { updates.push({ id, patch }); },
  applyClose: async (a) => { closes.push(a); return {}; },
  userProfile: {},
});
ok('обход: исполненная заявка превращена в открытую сделку', updates.some((u) => u.id === 'T1' && u.patch.status === 'open'));
ok('обход: исполненное закрытие применено и отметка снята', closes.length === 1 && closes[0].qty === 4 && updates.some((u) => u.id === 'T2' && u.patch.pendingClose === null));
ok('обход: сбой одной записи не мешает остальным и попадает в заметки', res.notes.some((n) => /BAD/.test(n)) && res.changed === 2);
ok('обход: обычные открытые сделки не трогаются', !updates.some((u) => u.id === 'T3'));
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки ожидающих заявок прошли ✓');
