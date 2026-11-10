// Проверка слежения за ГО и плечом фьючерсов (npm run test:margin). Сеть нужна только для одного контрольного пункта в конце
// (живая таблица биржи); недоступна — пункт пропускается, остальные идут без сети.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
import { isQuotaError, quotaHint } from './lib/quota.mjs';
import { canReuseHist, histPart, MAX_AGE_MS } from './lib/snapshotCache.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-margin-'));
fs.writeFileSync(path.join(tmp, 'marginTrack.js'), fs.readFileSync(path.join(__dirname, '../src/services/marketData/marginTrack.js'), 'utf8'));
const M = await import(pathToFileURL(path.join(tmp, 'marginTrack.js')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Модель ответа ISS (те же колонки, что в FORTS_URL).
const SC = ['SECID', 'SHORTNAME', 'ASSETCODE', 'LASTTRADEDATE', 'MINSTEP', 'STEPPRICE', 'INITIALMARGIN', 'LOTVOLUME', 'BUYSELLFEE', 'SECTYPE', 'PREVSETTLEPRICE', 'LOWLIMIT', 'HIGHLIMIT'];
const MC = ['SECID', 'LAST', 'SETTLEPRICE', 'UPDATETIME'];
const mk = (margin) => ({
  securities: {
    columns: SC,
    data: [
      ['MMZ6', 'MXI-12.26', 'MXI', '2026-12-17', 0.05, 0.5, margin, 1, 1.63, 'MM', 2466.6, 2330, 2602],
      ['MMH7', 'MXI-3.27', 'MXI', '2027-03-18', 0.05, 0.5, 3121.25, 1, 1.67, 'MM', 2541.5, 2388, 2694],
      ['RNZ6', 'ROSN-12.26', 'ROSN', '2026-12-17', 1, 1, 7695.96, 100, 7.27, 'RN', 36711, 32903, 40519],
      ['BRX6', 'BR-11.26', 'BR', '2026-11-16', 0.01, 8.2, 17000, 10, 10.5, 'BR', 97, 85, 109],
      ['BRZ6', 'BR-12.26', 'BR', '2026-12-01', 0.01, 8.2, 17209.89, 10, 10.56, 'BR', 97.36, 85, 109],
      ['EURRUBF', 'EURRUBF', 'EURRUBF', '2100-01-01', 0.001, 1, 15000, 1, 1, 'Eu', 90, 80, 100],
      ['SiZ6', 'Si-12.26', 'Si', '2026-12-17', 1, 1, 12916.8, 1000, 3.83, 'Si', 82795, 75734, 89856],
    ],
  },
  marketdata: { columns: MC, data: [['MMZ6', 2469.15, 2469.05, '20:26:53'], ['MMH7', null, 2544.65, '20:26:49'], ['RNZ6', 36220, 36222, '20:26:52'], ['BRX6', 94, 94, '20:26:00'], ['BRZ6', 94.04, 94.05, '20:26:55'], ['SiZ6', 83294, 83294, '20:26:55']] },
});
const NOW = new Date('2026-11-09T18:00:00Z');
const T = M.parseFortsTable(mk(2750.56));

// --- разбор таблицы
ok('разобрана таблица: 7 контрактов', T.size === 7);
const mm = T.get('MMZ6');
ok('MMZ6: ГО, шаг, стоимость шага, цена, лот', mm.margin === 2750.56 && mm.minStep === 0.05 && mm.stepPrice === 0.5 && mm.price === 2469.15 && mm.priceKind === 'last' && mm.lot === 1);
ok('цена: нет сделок → расчётная, нет и её → вчерашняя', T.get('MMH7').price === 2544.65 && T.get('MMH7').priceKind === 'settle');
ok('пустой/кривой ответ не роняет разбор', M.parseFortsTable(null).size === 0 && M.parseFortsTable({}).size === 0 && M.parseFortsTable({ securities: { columns: [], data: null } }).size === 0);

// --- стоимость контракта и плечо
// MMZ6: цена 2469,15 / шаг 0,05 × 0,5 ₽ = 24 691,5 ₽; ГО 2 750,56 → плечо ≈ 8,98
ok('стоимость контракта MMZ6 = 24 691,5 ₽', near(M.contractValueRub(mm), 24691.5, 1e-3));
ok('плечо MMZ6 ≈ 8,98×', near(M.leverageOf(M.contractValueRub(mm), mm.margin), 24691.5 / 2750.56, 1e-6));
ok('Brent: стоимость контракта через стоимость шага (94,04/0,01×8,2)', near(M.contractValueRub(T.get('BRZ6')), 94.04 / 0.01 * 8.2, 1e-6));
ok('нечего считать → 0, а не NaN', M.leverageOf(0, 100) === 0 && M.leverageOf(100, 0) === 0 && M.contractValueRub({ minStep: 0, stepPrice: 1, price: 5 }) === 0);

// --- какой контракт стоит за тикером
ok('конкретный код → он сам (без учёта регистра)', M.resolveContract(T, 'mmz6', NOW).row.secid === 'MMZ6' && M.resolveContract(T, 'SiZ6', NOW).viaRoot === null);
ok('корень MM → ближайший MMZ6 (до экспирации 38 дней)', M.resolveContract(T, 'MM', NOW).row.secid === 'MMZ6' && M.resolveContract(T, 'MM', NOW).viaRoot === 'MM');
ok('корень BR: BRX6 истекает через 7 дн, берём его; за 3 дня до конца — уже следующий BRZ6',
  M.resolveContract(T, 'BR', NOW).row.secid === 'BRX6' && M.resolveContract(T, 'BR', new Date('2026-11-13T10:00:00Z')).row.secid === 'BRZ6');
ok('после экспирации старый контракт не выбирается', M.resolveContract(T, 'BR', new Date('2026-12-05T10:00:00Z')) === null);
ok('регистр корня не важен (SI → SiZ6), вечный EURRUBF под корень Eu не попадает', M.resolveContract(T, 'SI', NOW).row.secid === 'SiZ6' && M.resolveContract(T, 'EU', NOW) === null);
ok('несуществующий тикер → null', M.resolveContract(T, 'XXZ9', NOW) === null && M.resolveContract(T, '', NOW) === null);

// --- настройки
ok('настройки по умолчанию: радар и позиции вкл., порог 3 %', JSON.stringify(M.marginPrefsOf(undefined)) === JSON.stringify({ radar: true, open: true, minPct: 3 }));
ok('настройки: выключено/порог 5/кривой порог', M.marginPrefsOf({ marginNotifyRadar: false, marginNotifyPct: '5' }).radar === false && M.marginPrefsOf({ marginNotifyPct: '5' }).minPct === 5 && M.marginPrefsOf({ marginNotifyPct: 'abc' }).minPct === 3 && M.marginPrefsOf({ marginNotifyPct: 900 }).minPct === 50);

// --- проход слежения
const PREFS = { radar: true, open: true, minPct: 3 };
const wanted = [{ ticker: 'MM', scope: 'radar' }, { ticker: 'RNZ6', scope: 'radar' }];
let run1 = M.planMarginRun({ prev: null, wanted, table: T, prefs: PREFS, now: NOW, today: '2026-11-09' });
ok('первый проход: только запоминаем, сообщений нет', run1.changes.length === 0 && run1.rolls.length === 0 && Object.keys(run1.state.items).length === 2);
ok('в состоянии корень MM привязан к MMZ6', run1.state.roots.MM === 'MMZ6' && run1.state.items.MMZ6.src === 'moex');

// ГО выросло на 5 %
const T2 = M.parseFortsTable(mk(2750.56 * 1.05));
let run2 = M.planMarginRun({ prev: run1.state, wanted, table: T2, prefs: PREFS, now: new Date(NOW.getTime() + 3600e3), today: '2026-11-09' });
ok('ГО +5 % → одно изменение по MMZ6, RNZ6 не тронут', run2.changes.length === 1 && run2.changes[0].secid === 'MMZ6' && near(run2.changes[0].pct.buy, 5, 1e-6));
ok('в состоянии видно прошлое значение и время изменения', near(run2.state.items.MMZ6.prevBuy, 2750.56, 1e-6) && !!run2.state.items.MMZ6.since);
const msg = M.formatMarginMessage(run2);
ok('сообщение: плечо — главное и первое (8,98× → 8,55× при цене), затем ГО было → стало с копейками и процентом, пометка про биржу', /Изменилось плечо/.test(msg) && /MMZ6/.test(msg) && /плечо 8,98× → 8,55× \(при цене 2\s?469\)/.test(msg) && /ГО 2\s?750,56 → 2\s?888,09 ₽ \(\+5,0 %\)/.test(msg) && msg.indexOf('плечо 8,98') < msg.indexOf('ГО 2') && /по данным биржи/.test(msg));
ok('плечо в сообщении упало (было 8,98×, стало 8,55×: 24 691,5 / 2 888,09)', /8,98× → 8,55×/.test(msg));

// Маленькие шаги копятся: +2 %, затем ещё +2 % → вместе 4 % ≥ порога → сообщение на втором шаге
const Ta = M.parseFortsTable(mk(2750.56 * 1.02)), Tb = M.parseFortsTable(mk(2750.56 * 1.0404));
let s1 = M.planMarginRun({ prev: run1.state, wanted, table: Ta, prefs: PREFS, now: NOW, today: 'x' });
let s2 = M.planMarginRun({ prev: s1.state, wanted, table: Tb, prefs: PREFS, now: NOW, today: 'x' });
ok('+2 % — молчим; ещё +2 % (всего ≈4 %) — сообщаем', s1.changes.length === 0 && s2.changes.length === 1 && near(s2.changes[0].pct.buy, 4.04, 0.01));
// после сообщения база сдвинута: повторный проход с тем же ГО молчит
let s3 = M.planMarginRun({ prev: s2.state, wanted, table: Tb, prefs: PREFS, now: NOW, today: 'x' });
ok('повторный проход с тем же ГО — тишина', s3.changes.length === 0);

// Снижение тоже сообщается
const Tdown = M.parseFortsTable(mk(2750.56 * 0.9));
let d1 = M.planMarginRun({ prev: run1.state, wanted, table: Tdown, prefs: PREFS, now: NOW, today: 'x' });
ok('ГО −10 % сообщается со знаком «−»', d1.changes.length === 1 && /−10 %/.test(M.formatMarginMessage(d1)));

// Выключенные настройки: базу сдвигаем молча
let off = M.planMarginRun({ prev: run1.state, wanted, table: T2, prefs: { ...PREFS, radar: false }, now: NOW, today: 'x' });
ok('радар выключен → сообщения нет', off.changes.length === 0 && M.formatMarginMessage(off) === null);
let back = M.planMarginRun({ prev: off.state, wanted, table: T2, prefs: PREFS, now: NOW, today: 'x' });
ok('…и при включении «старое» изменение не приходит', back.changes.length === 0);

// Позиция сильнее радара; открытая позиция при выключенном «радаре» всё равно сообщает
let pos = M.planMarginRun({ prev: run1.state, wanted: [{ ticker: 'MMZ6', scope: 'radar' }, { ticker: 'MM', scope: 'radar' }, { ticker: 'MMZ6', scope: 'open' }], table: T2, prefs: { ...PREFS, radar: false }, now: NOW, today: 'x' });
ok('дубль радар+позиция → один раз, как «открытая позиция»', pos.changes.length === 1 && pos.changes[0].scope === 'open' && /открытая позиция/.test(M.formatMarginMessage(pos)));

// Источник сменился (появился Т-Банк): не «изменение ГО»
const tb = new Map([['MMZ6', { buy: 2900, sell: 3300 }]]);
let sw = M.planMarginRun({ prev: run1.state, wanted, table: T, tbank: tb, prefs: PREFS, now: NOW, today: 'x' });
ok('источник moex → tbank не считается изменением, база новая', sw.changes.length === 0 && sw.state.items.MMZ6.src === 'tbank' && sw.state.items.MMZ6.sell === 3300);
// У Т-Банка лонг и шорт разные — в сообщении обе стороны
const tb2 = new Map([['MMZ6', { buy: 2900 * 1.1, sell: 3300 * 1.1 }]]);
let sw2 = M.planMarginRun({ prev: sw.state, wanted, table: T, tbank: tb2, prefs: PREFS, now: NOW, today: 'x' });
const m2 = M.formatMarginMessage(sw2);
ok('Т-Банк: сообщение с лонгом и шортом, без пометки «по данным биржи»', sw2.changes.length === 1 && /лонг/.test(m2) && /шорт/.test(m2) && !/по данным биржи/.test(m2));

// Смена контракта у корня
const T3 = M.parseFortsTable({ ...mk(2750), securities: { columns: SC, data: mk(2750).securities.data.filter((r) => r[0] !== 'MMZ6') } });
let roll = M.planMarginRun({ prev: run1.state, wanted, table: T3, prefs: PREFS, now: NOW, today: 'x' });
ok('корень MM перешёл с MMZ6 на MMH7 → сообщение о смене контракта', roll.rolls.length === 1 && roll.rolls[0].from === 'MMZ6' && roll.rolls[0].to === 'MMH7' && /Контракт сменился/.test(M.formatMarginMessage(roll)));
ok('при смене контракта ГО нового не считается «изменением»', roll.changes.length === 0);

// Экспирация открытой позиции: предупреждаем раз в сутки
const nearExp = new Date('2026-12-14T10:00:00Z'); // до 17 декабря 3 дня
let e1 = M.planMarginRun({ prev: null, wanted: [{ ticker: 'MMZ6', scope: 'open' }, { ticker: 'RNZ6', scope: 'radar' }], table: T, prefs: PREFS, now: nearExp, today: '2026-12-14' });
ok('до экспирации 3 дня: предупреждение только по открытой позиции', e1.expiring.length === 1 && e1.expiring[0].secid === 'MMZ6' && e1.expiring[0].daysLeft === 3);
let e2 = M.planMarginRun({ prev: e1.state, wanted: [{ ticker: 'MMZ6', scope: 'open' }], table: T, prefs: PREFS, now: nearExp, today: '2026-12-14' });
let e3 = M.planMarginRun({ prev: e2.state, wanted: [{ ticker: 'MMZ6', scope: 'open' }], table: T, prefs: PREFS, now: new Date('2026-12-15T10:00:00Z'), today: '2026-12-15' });
ok('в тот же день повторно не предупреждаем, на следующий — снова', e2.expiring.length === 0 && e3.expiring.length === 1);
ok('текст предупреждения', /Скоро экспирация/.test(M.formatMarginMessage(e1)) && /3 дн/.test(M.formatMarginMessage(e1)));
ok('радар (не позиция) об экспирации не предупреждает', M.planMarginRun({ prev: null, wanted: [{ ticker: 'MMZ6', scope: 'radar' }], table: T, prefs: PREFS, now: nearExp, today: 'x' }).expiring.length === 0);

// Неизвестный тикер не роняет проход
let miss = M.planMarginRun({ prev: null, wanted: [{ ticker: 'ZZZ9', scope: 'radar' }], table: T, prefs: PREFS, now: NOW, today: 'x' });
ok('несуществующий тикер попадает в missing, проход не падает', miss.missing[0] === 'ZZZ9' && Object.keys(miss.state.items).length === 0);

// --- строка для радара
const v = M.marginView({ ticker: 'MM', table: T, state: run1.state, now: NOW });
ok('радар: корень MM показывает данные MMZ6', v.secid === 'MMZ6' && v.viaRoot === 'MM' && v.src === 'moex');
ok('радар: строка «плечо 8,98× · ГО 2 750,56 ₽» — плечо первым, ничего не округлено', /^плечо 8,98× · ГО 2\s750,56 ₽$/.test(M.marginLine(v)));
ok('плечо в радаре не округляется до целого: 8,6× и 9,4× — разные подписи («8,60×», «9,40×»), малое — тоже два знака', M.levShort(8.6) === '8,60×' && M.levShort(9.4) === '9,40×' && M.levShort(4.26) === '4,26×' && M.levShort(0) === '');
ok('ГО с копейками: 2 750,56; целое — без «,00»', M.ruGo(2750.56) === '2\u00a0750,56' && M.ruGo(3300) === '3\u00a0300' && M.ruGo(3300.5) === '3\u00a0300,50');
// ГО брокера, которое приложение спросило само, главнее и биржевого, и состояния робота
const brk = new Map([['MMZ6', { buy: 2900.12, sell: 3300.5 }]]);
const vBrk = M.marginView({ ticker: 'MM', table: T, state: run1.state, broker: brk, now: NOW });
ok('радар: ГО Т-Банка, спрошенное в приложении, главнее биржевого — src «tbank», лонг/шорт отдельно', vBrk.src === 'tbank' && vBrk.buy === 2900.12 && vBrk.sell === 3300.5 && /^плечо 8,51× \/ 7,48× · ГО лонг 2\s900,12 \/ шорт 3\s300,50 ₽$/.test(M.marginLine(vBrk)));
ok('…а без ответа брокера остаётся биржа', M.marginView({ ticker: 'MM', table: T, state: run1.state, broker: new Map(), now: NOW }).src === 'moex' && M.marginView({ ticker: 'MM', table: T, state: run1.state, broker: null, now: NOW }).src === 'moex');
ok('…и если у брокера пришла только одна сторона, вторая берётся такой же', M.marginView({ ticker: 'MM', table: T, state: null, broker: new Map([['MMZ6', { buy: 3000, sell: 0 }]]), now: NOW }).sell === 3000);
const vTb = M.marginView({ ticker: 'MMZ6', table: T, state: { ...sw.state }, now: NOW });
ok('радар: данные Т-Банка (лонг/шорт) показываются, пока состояние свежее', vTb.src === 'tbank' && /лонг 2\s?900 \/ шорт 3\s?300/.test(M.marginLine(vTb)));
const vOld = M.marginView({ ticker: 'MMZ6', table: T, state: { ...sw.state, at: '2026-11-01T00:00:00Z' }, now: NOW });
ok('…а устаревшее состояние (>36 ч) не выдаётся за актуальное: показываем биржу', vOld.src === 'moex' && vOld.buy === 2750.56);
const vChg = M.marginView({ ticker: 'MMZ6', table: T2, state: run2.state, now: NOW });
ok('радар: изменение ГО (+5 %) запомнено и значок виден — подпись плеча теперь другая (8,98× → 8,55×)', vChg.change && near(vChg.change.pct, 5, 1e-6) && vChg.change.visible === true && M.levShort(vChg.change.levFrom) === '8,98×' && M.levShort(vChg.change.levTo) === '8,55×');
ok('значок «было …» не показывается, если ГО спрошено у брокера, а робот следил за биржей (числа разных источников не сравниваем)', M.marginView({ ticker: 'MMZ6', table: T2, state: run2.state, broker: brk, now: NOW }).change === null);
const bigPrev = { at: NOW.toISOString(), items: { MMZ6: { buy: 2292.13, sell: 2292.13, src: 'moex', prevBuy: 2292.13, prevSell: 2292.13, since: NOW.toISOString() } } };
const vBig = M.marginView({ ticker: 'MMZ6', table: T, state: { ...bigPrev, items: { MMZ6: { buy: 2750.56, sell: 2750.56, src: 'moex', prevBuy: 2292.13, prevSell: 2292.13, since: NOW.toISOString() } } }, now: NOW });
ok('радар: ГО +20 % меняет подпись плеча (10,77× → 8,98×) — значок виден', vBig.change.visible === true && M.levShort(vBig.change.levFrom) === '10,77×' && M.levShort(vBig.change.levTo) === '8,98×');
const vChgOld = M.marginView({ ticker: 'MMZ6', table: T2, state: run2.state, now: new Date(NOW.getTime() + 20 * 86400e3) });
ok('…и пропадает через 14 суток', vChgOld.change === null);
ok('нет такого фьючерса → null, пустая строка', M.marginView({ ticker: 'ZZZ9', table: T, state: null, now: NOW }) === null && M.marginLine(null) === '');

// --- ограничения чтений базы
ok('квота: код 8 и текст RESOURCE_EXHAUSTED распознаются', isQuotaError({ code: 8 }) && isQuotaError(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.')) && !isQuotaError(new Error('network')) && !isQuotaError(null));
ok('квота: подсказка человеческая и пустая для прочих ошибок', /50 000/.test(quotaHint({ code: 8 })) && quotaHint(new Error('x')) === null);
const NOWMS = Date.parse('2026-11-09T12:00:00Z');
const prevSnap = { hist: { at: '2026-11-09T11:00:00Z', counts: { paperAll: 100, paperOpen: 2, real: 50, realOpen: 1 } }, paperClosed: {}, paperByStrategy: [], realByStrategy: [], paperClosedList: [], realClosedList: [] };
const cnt = { paperAll: 100, paperOpen: 2, real: 50, realOpen: 1 };
ok('снимок: ничего не менялось и свежий → историю не перечитываем', canReuseHist(prevSnap, cnt, NOWMS) === true);
ok('снимок: закрылась/открылась бумажная (счётчики изменились) → пересчёт', canReuseHist(prevSnap, { ...cnt, paperOpen: 3 }, NOWMS) === false && canReuseHist(prevSnap, { ...cnt, paperAll: 101 }, NOWMS) === false);
ok('снимок: новая запись журнала → пересчёт', canReuseHist(prevSnap, { ...cnt, real: 51 }, NOWMS) === false);
ok('снимок: старше 3 часов → пересчёт; нет счётчиков (count не получился) → пересчёт', canReuseHist(prevSnap, cnt, NOWMS + MAX_AGE_MS) === false && canReuseHist(prevSnap, { ...cnt, real: null }, NOWMS) === false);
ok('снимок: нет прошлого или без истории → пересчёт', canReuseHist(null, cnt, NOWMS) === false && canReuseHist({ hist: prevSnap.hist }, cnt, NOWMS) === false);
ok('снимок: переносится ровно историческая часть', Object.keys(histPart(prevSnap)).sort().join() === 'paperByStrategy,paperClosed,paperClosedList,realByStrategy,realClosedList');

// --- контроль на живых данных биржи (без сети — пропуск)
try {
  const res = await fetch(M.FORTS_URL, { signal: AbortSignal.timeout(30000) });
  const live = M.parseFortsTable(await res.json());
  ok(`живая таблица биржи: ${live.size} фьючерсов, у всех есть ГО и шаг`, live.size > 100 && [...live.values()].every((r) => r.margin > 0 && r.minStep > 0 && r.stepPrice > 0));
  const roots = ['BR', 'NG', 'PT', 'PD', 'GK', 'LK', 'RN', 'VB', 'MX', 'MM', 'RI', 'SR', 'GZ', 'GD', 'SV', 'SI', 'EU', 'CR', 'WT'];
  const bad = roots.filter((r) => { const x = M.resolveContract(live, r, new Date()); return !x || !(M.leverageOf(M.contractValueRub(x.row), x.row.margin) > 1); });
  ok(`живая таблица: для всех ${roots.length} корней приложения находится контракт и считается плечо${bad.length ? ' (нет: ' + bad.join(',') + ')' : ''}`, bad.length === 0);
} catch (e) { console.log(`— нет сети (${e.message}): контрольный пункт на живых данных пропущен`); }

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки прошли');
process.exitCode = fails ? 1 : 0;
