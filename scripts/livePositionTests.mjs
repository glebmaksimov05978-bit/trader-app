// scripts/livePositionTests.mjs
//
// Проверка линии «как есть» (mode: 'actual') в src/services/backtest/livePosition.js:
// npm run test:live
//
// Зачем этот тест вообще появился. Вкладка «Сопровождение» показывала трейдеру «когорта:
// 2 фиксации» и «в рынке 50%» по сделке, где он НИЧЕГО не фиксировал (реальная жалоба:
// «я нигде не фиксировал, а система пишет, что зафиксировал»). Причина: линия «как есть»
// гоняла движок по свечам, а движок в процессе резал позицию сам — и его гипотетические
// действия попадали в состояние реальной сделки. Теперь движок в этой линии только
// смотрит, а остаток и число фиксаций меняют ТОЛЬКО реальные операции трейдера.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-live-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy', 'exitRules']) {
  esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
  ["from '../analytics/", "from './"], ["from '../../utils/calculator.js'", "from './calculator.js'"],
]);
const liveUrl = esmify(path.join(repoRoot, 'src/services/backtest/livePosition.js'), [["from './engine'", "from './engine.js'"]]);
const { computeLiveState, computeBothLines } = await import(liveUrl);

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('  ПРОВАЛ:', m); fails++; } };

// Свечи: 260 баров прогрева в боковике, затем сильный рост и откат. На таком движении
// профит-система гарантированно захочет резать — что нам и нужно для проверки.
function buildCandles() {
  const out = [];
  const start = new Date('2025-01-01T00:00:00Z').getTime();
  const push = (i, close) => {
    const prev = out.length ? out[out.length - 1].close : close;
    out.push({
      date: new Date(start + i * 86400000),
      open: prev,
      high: Math.max(prev, close) * 1.004,
      low: Math.min(prev, close) * 0.996,
      close,
      volume: 1_000_000 + (i % 7) * 50_000,
    });
  };
  let price = 100;
  for (let i = 0; i < 260; i++) { price = 100 + Math.sin(i / 6) * 1.5; push(i, price); }
  for (let i = 260; i < 285; i++) { price *= 1.012; push(i, price); }   // рост ~+34%
  for (let i = 285; i < 300; i++) { price *= 0.994; push(i, price); }   // откат
  return out;
}

const candles = buildCandles();
const entryIndex = 260;
const RULES = {
  stopType: 'none', takeType: 'none', trailEnabled: true, trailGiveBackPct: 50,
  trailMinPeakMode: 'pct', trailMinPeakPct: 1, trailAdverseEnabled: true, trailAdverseMult: 2,
  profitCaptureEnabled: true, profitCaptureThreshold: 4,
  profitCutByScore: { 4: 0.25, 5: 0.34, 6: 0.5, 7: 1, 8: 1 }, profitCutMaxTimes: 4,
  trailLossRule: 'score', lossScoreMode: 'nearBottom', lossScoreThreshold: 2,
  lossCutByScore: { 2: 0.34, 3: 0.5, 4: 1 }, lossCutMaxTimes: 3,
};
const base = { candles, entryIndex, direction: 'long', entryPrice: candles[entryIndex].close, rules: RULES };

// --- 1. Трейдер не фиксировал ничего --------------------------------------------------
const untouched = computeLiveState({ ...base, mode: 'actual', actualFills: [] });
console.log(`Без фиксаций: остаток ${untouched.remaining}, фиксаций ${untouched.profitCutsDone}, `
  + `когорта "${untouched.cohort}", движок предлагал ${untouched.fired.length} раз`);
ok(untouched.remaining === 1, `остаток должен быть 1 (весь объём в рынке), получили ${untouched.remaining}`);
ok(untouched.profitCutsDone === 0, `фиксаций должно быть 0, получили ${untouched.profitCutsDone}`);
ok(untouched.cohort === '0', `когорта должна быть "0", получили "${untouched.cohort}"`);
// Само предложение движка при этом никуда не делось — оно просто не считается действием.
ok(untouched.fired.length > 0, 'движок должен был хотя бы раз предложить фиксацию на таком движении');
ok(untouched.fired.every((f) => f.suggested === true), 'в линии «как есть» срабатывания помечены как предложения');

// --- 2. Панели показывают ТЕКУЩИЙ бар, а не тот, где движок вышел бы -------------------
ok(untouched.now != null, 'должно быть состояние на текущем баре');
ok(untouched.now.index === candles.length - 1,
  `счёт должен считаться на последнем баре (${candles.length - 1}), а не на ${untouched.now?.index}`);
ok(untouched.barsHeld === candles.length - 1 - entryIndex,
  `держим ${candles.length - 1 - entryIndex} баров, получили ${untouched.barsHeld}`);
ok(untouched.exit === null, 'саму сделку линия «как есть» закрывать не вправе');
// wouldExit тут пуст намеренно: движок в этой линии только предлагает резать частями, а
// раз трейдер не режет, позиция никогда не «истощается» до полного выхода. Совет всегда
// относится к тому объёму, который реально в рынке, — поэтому предложение повторяется.
ok(untouched.fired.length > 1, 'предложение должно повторяться, пока трейдер его не выполнил');

// --- 2b. Жёсткий выход (стоп) отмечается, но сделку не закрывает ----------------------
// Цена дошла до +34% и откатилась к +21%, поэтому «подтянутый» стоп на +25% от входа
// на этом откате обязан быть задет.
const stopped = computeLiveState({
  ...base, mode: 'actual', actualFills: [],
  stopPrice: candles[entryIndex].close * 1.25,
});
console.log(`Со стопом: exit=${stopped.exit?.reason || 'нет'}, wouldExit=${stopped.wouldExit?.reason || 'нет'}, `
  + `счёт на баре ${stopped.now?.index} из ${candles.length - 1}`);
ok(stopped.wouldExit?.reason === 'stop', `стоп должен быть отмечен как wouldExit, получили ${stopped.wouldExit?.reason}`);
ok(stopped.exit === null, 'но сделка в Журнале открыта — линия «как есть» её не закрывает');
ok(stopped.now.index === candles.length - 1, 'и счёт всё равно считается на последнем баре');

// --- 3. Реальные фиксации трейдера — единственное, что меняет остаток ------------------
const withFills = computeLiveState({
  ...base, mode: 'actual',
  actualFills: [{ index: 270, fraction: 0.4 }, { index: 280, fraction: 0.2 }],
});
console.log(`С двумя фиксациями: остаток ${withFills.remaining.toFixed(2)}, фиксаций ${withFills.profitCutsDone}, когорта "${withFills.cohort}"`);
ok(Math.abs(withFills.remaining - 0.4) < 1e-9, `остаток должен быть 0.4, получили ${withFills.remaining}`);
ok(withFills.profitCutsDone === 2, `фиксаций должно быть 2, получили ${withFills.profitCutsDone}`);
ok(withFills.cohort === '2+', `когорта должна быть "2+", получили "${withFills.cohort}"`);

// --- 4. Теневая линия по-прежнему живёт своей жизнью и действительно режет -------------
const shadow = computeLiveState({ ...base, mode: 'shadow' });
console.log(`Теневая линия: остаток ${shadow.remaining.toFixed(2)}, фиксаций ${shadow.profitCutsDone}, выход: ${shadow.exit?.reason || 'нет'}`);
ok(shadow.profitCutsDone > 0 || shadow.exit != null, 'теневая линия должна была действовать: резать или выйти');
ok(shadow.fired.every((f) => !f.suggested), 'в теневой линии срабатывания — свершившийся факт, не предложение');

// --- 5. Обе линии вместе: расхождение считается по ИТОГАМ, а не по цене ----------------
const both = computeBothLines({ ...base, actualFills: [] });
ok(Number.isFinite(both.deltaPct), 'расхождение линий должно быть числом');
ok(both.actual.remaining === 1, 'в обеих линиях сразу реальная линия остаётся нетронутой');
console.log(`Итоги: ты ${both.actual.resultPct.toFixed(2)}%, система ${both.shadow.resultPct.toFixed(2)}%, `
  + `расхождение ${both.deltaPct.toFixed(2)} п.п.`);
// Движок на этом движении фиксировал по пути и вышел на откате — он ОБЯЗАН отличаться от
// трейдера, который просто досидел до последнего бара. Раньше обе линии показывали одну и
// ту же цену последнего бара, и вкладка писала «решения совпали» всегда.
ok(Math.abs(both.deltaPct) > 0.5,
  `линии должны разойтись: система резала и вышла, трейдер держал (получили ${both.deltaPct.toFixed(2)} п.п.)`);
// Кто именно окажется впереди — зависит от траектории (на ровном росте частичные фиксации
// проигрывают удержанию, на развороте выигрывают), поэтому направление не проверяем. Важно
// другое: итог теневой линии считается по ЕЁ фиксациям, а не по цене последнего бара.
ok(Math.abs(both.shadow.resultPct - both.shadow.currentPct) > 0.5,
  'итог системы должен отличаться от цены последнего бара — она фиксировала по пути');
// У линии «как есть» без фиксаций итог совпадает с движением цены — фиксировать было нечего.
ok(Math.abs(both.actual.resultPct - both.actual.currentPct) < 1e-9,
  'без фиксаций итог линии «как есть» равен движению цены');

console.log(fails === 0 ? '\nВсе проверки линии «как есть» прошли ✓' : `\n${fails} проверок провалено`);
process.exit(fails ? 1 : 0);
