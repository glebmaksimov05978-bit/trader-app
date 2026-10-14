// Проверка карточки сигнала, кнопок решений и утренней сводки (npm run test:signalcard).
import {
  formatPaperSignalCard, formatMorningDigest, paperDecisionKeyboard, ambiguousEntryKeyboard, notThisKeyboard,
  buildReasonKeyboard, describeDecision, paperTelegramAllowed, isPaperRef, paperRef, PAPER_SKIP_REASONS, DEFAULT_ALERT_PREFS,
} from '../src/services/alerts.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const strip = (t) => t.replace(/<[^>]+>/g, '');

const trade = { ticker: 'SBER', direction: 'long', entryPrice: 301.2, stopLoss: 294.1, takeProfit: 318, volume: 10, entryStrategyName: 'Пробой', entryTimeframe: 'H1' };

// ---------- карточка сигнала ----------
const card = formatPaperSignalCard({
  trade, caption: 'краткосрок · Ч1', riskRub: 710, riskPct: 0.7, signalBar: '14.10 18:00',
  conditions: [{ label: 'Цена выше EMA200', passed: true }, { label: 'RSI ниже 35', passed: true }, { label: 'Объём выше среднего', passed: false }],
});
const text = strip(card);
ok('в заголовке стратегия, тикер и направление', /Бумажная · «Пробой» — SBER лонг, сигнал/.test(text));
ok('подзаголовок: горизонт, таймфрейм и свеча', /краткосрок · Ч1 · свеча 14\.10 18:00/.test(text));
ok('вход, стоп и цель в процентах', /Вход 301,2/.test(text) && /Стоп 294,1 \(−2,4%\)/.test(text) && /Цель 318 \(\+5,6%\)/.test(text));
ok('прибыль к риску = 16,8 / 7,1 ≈ 2,4', /Прибыль к риску: 2,4 : 1/.test(text));
ok('объём и риск в рублях и процентах', /Объём 10 · риск ≈ 710 ₽ \(0,7% капитала\)/.test(text));
ok('условия: 2 из 3, с отметками', /Условия стратегии: 2 из 3/.test(text) && /✅ Цена выше EMA200/.test(text) && /▫️ Объём выше среднего/.test(text));

const short = strip(formatPaperSignalCard({ trade: { ...trade, direction: 'short', stopLoss: 308.3, takeProfit: 284.4 } }));
ok('шорт: стоп выше входа — минус, цель ниже — плюс', /Стоп 308,3 \(−2,4%\)/.test(short) && /Цель 284,4 \(\+5,6%\)/.test(short) && /шорт/.test(short));
const noStop = strip(formatPaperSignalCard({ trade: { ...trade, stopLoss: null } }));
ok('без стопа: об этом сказано, прибыль к риску не выдумывается', /Стопа нет/.test(noStop) && !/Прибыль к риску/.test(noStop));
const noCond = strip(formatPaperSignalCard({ trade: { ...trade, entryPassed: 5, entryTotal: 6 } }));
ok('без списка условий — счёт из записи сделки', /Условия стратегии: 5 из 6/.test(noCond));
ok('условный объём помечен', /Объём условный/.test(strip(formatPaperSignalCard({ trade: { ...trade, riskTooBig: true } }))));
const evil = formatPaperSignalCard({ trade: { ...trade, entryStrategyName: 'A<b>&B' }, conditions: [{ label: '1 < 2 & 3', passed: true }] });
ok('спецсимволы экранируются (иначе Telegram не доставит)', !/A<b>&B/.test(evil) && /A&lt;b&gt;&amp;B/.test(evil) && /1 &lt; 2 &amp; 3/.test(evil));
ok('больше десяти условий — показываются десять', (card.match(/✅|▫️/g) || []).length === 3
  && (formatPaperSignalCard({ trade, conditions: Array.from({ length: 14 }, (_, i) => ({ label: `у${i}`, passed: true })) }).match(/✅/g) || []).length === 10);

// ---------- кнопки ----------
const kb = paperDecisionKeyboard('abc123');
ok('«Вошёл» и «Пропустил» в одной строке', kb.inline_keyboard[0].length === 2 && kb.inline_keyboard[0][0].callback_data === 'd|P:abc123|en' && kb.inline_keyboard[0][1].callback_data === 'd|P:abc123|sk');
ok('«Повторить реально» остаётся прежней кнопкой', kb.inline_keyboard[1][0].callback_data === 'x|o|abc123');
ok('без «Повторить»', paperDecisionKeyboard('abc123', { repeat: false }).inline_keyboard.length === 1);
ok('нет id — нет клавиатуры', paperDecisionKeyboard(null) === null && notThisKeyboard('') === null);
const allCb = [...kb.inline_keyboard.flat(), ...ambiguousEntryKeyboard([{ paperId: 'a'.repeat(20), strategy: 'Длинное название стратегии для проверки' }]).inline_keyboard.flat(), ...notThisKeyboard('a'.repeat(20)).inline_keyboard.flat()];
ok('данные кнопок не длиннее 64 байт (лимит Telegram)', allCb.every((b) => new TextEncoder().encode(b.callback_data).length <= 64));
const amb = ambiguousEntryKeyboard([{ paperId: 'pa', strategy: 'Пробой' }, { paperId: 'pb', strategy: 'Откат' }]);
ok('неоднозначный вход: по кнопке на стратегию и «Ни по одной»', amb.inline_keyboard.length === 3 && amb.inline_keyboard[0][0].callback_data === 'd|P:pa|en' && amb.inline_keyboard[2][0].callback_data === 'd|P:pa|nt');
ok('префикс бумажных', isPaperRef(paperRef('x')) && !isPaperRef('x'));

// ---------- причины и расшифровка ----------
const reasons = buildReasonKeyboard('P:abc').inline_keyboard.map((r) => r[0].text);
ok('для бумажных свои причины: нет «Держу до цели», есть «Лимит риска исчерпан»', !reasons.includes('Держу до цели') && reasons.includes('Лимит риска исчерпан'));
ok('для настоящих сделок причины прежние', buildReasonKeyboard('realid').inline_keyboard.map((r) => r[0].text).includes('Держу до цели'));
ok('«Вошёл» расшифровывается', describeDecision('en').action === 'entered');
ok('«Это не по сигналу» расшифровывается', describeDecision('nt').action === 'not_this');
ok('бумажные причины расшифровываются', PAPER_SKIP_REASONS.every((r) => describeDecision(r.code).label === r.label && describeDecision(r.code).action === 'skipped'));
ok('старые коды работают как раньше', describeDecision('fp').action === 'fixed_partial' && describeDecision('r5').label === 'Держу до цели' && describeDecision('zzz').label === 'Ничего не делал');

// ---------- настройки по умолчанию ----------
ok('кнопки решений выключены, пока бот не обновлён', DEFAULT_ALERT_PREFS.paperDecisionButtons === false);
ok('сводка включена, час 8', DEFAULT_ALERT_PREFS.morningDigest === true && DEFAULT_ALERT_PREFS.digestHour === 8);
ok('наблюдение глушит уведомления и сейчас', paperTelegramAllowed({}, 'a', [{ id: 'a', observe: true }]) === false);

// ---------- утренняя сводка ----------
const digest = formatMorningDigest({
  date: new Date(2026, 9, 14), // среда, 14 октября
  open: [{ ticker: 'SBER', direction: 'long', strategy: 'Пробой', entryPrice: 301.2, stopLoss: 294.1, takeProfit: null, days: 2 }],
  paper: [{ ticker: 'GAZP', direction: 'short', strategy: 'Откат', caption: 'краткосрок · Ч1' }],
  near: [{ ticker: 'LKOH', passed: 5, total: 6, strategy: 'Пробой' }],
  risk: { riskRub: 710, riskPct: 0.7, count: 1 },
  yesterday: { count: 2, pnl: -300 },
  pendingDecisions: 1,
});
const dt = strip(digest);
ok('заголовок: день недели и дата', /Утренняя сводка — среда, 14 октября/.test(dt));
ok('позиция в рынке с входом, стопом и сроком', /SBER лонг · «Пробой» — вход 301,2, стоп 294,1, 2 дн\./.test(dt));
ok('риск открытых позиций', /Риск открытых позиций: 710 ₽ \(0,7% депозита\)/.test(dt));
ok('бумажные с подписью', /GAZP шорт · «Откат» \(краткосрок · Ч1\)/.test(dt));
ok('ждёт отметки: единственное число', /Ждут вашей отметки: 1 сигнал —/.test(dt));
ok('близко к входу', /LKOH — 5 из 6 условий \(«Пробой»\)/.test(dt));
ok('вчера: минус', /Вчера: закрыто 2, итог −300 ₽/.test(dt));
ok('пусто — слать нечего', formatMorningDigest({ date: new Date() }) === null);
const onlyNear = strip(formatMorningDigest({ date: new Date(2026, 9, 14), near: [{ ticker: 'X', passed: 2, total: 3 }] }));
ok('только одна секция — остальных нет', /Близко к входу/.test(onlyNear) && !/В рынке/.test(onlyNear) && !/Бумажные/.test(onlyNear));
ok('больше восьми позиций — «и ещё»', /и ещё 2/.test(strip(formatMorningDigest({ date: new Date(2026, 9, 14), open: Array.from({ length: 10 }, (_, i) => ({ ticker: `T${i}`, direction: 'long', entryPrice: 1 })) }))));
ok('экранирование в сводке', !/<script>/.test(formatMorningDigest({ date: new Date(2026, 9, 14), paper: [{ ticker: '<script>', direction: 'long' }] })));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки карточки сигнала и сводки прошли ✓');
