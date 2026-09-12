// scripts/commissionTests.mjs
//
// Проверка ставки комиссии: npm run test:commission
//
// Здесь проверяется связка «код тикера → тип инструмента → ставка тарифа». Реальный баг,
// ради которого этот тест написан: в Калькуляторе тип брался из переключателя «Фьючерс /
// Акция», который по умолчанию стоит на фьючерсе. Трейдер загрузил SVCB (обычная акция,
// биржа прямо подписала «Акция MOEX») — и комиссия посчиталась по ФЬЮЧЕРСНОЙ ставке
// тарифа «Трейдер»: 0.04% вместо 0.05%. Ошибка тихая: цифра выглядит правдоподобно, а
// неверный тип потом сохраняется в саму сделку и по нему считается её закрытие.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-comm-'));

// Оба модуля ни от чего не зависят — достаточно скопировать их под расширением .mjs,
// чтобы Node прочитал их как модули. Никаких заглушек.
function load(relPath) {
  const src = path.join(repoRoot, relPath);
  const out = path.join(tmp, path.basename(relPath).replace(/\.js$/, '.mjs'));
  fs.writeFileSync(out, fs.readFileSync(src, 'utf8'), 'utf8');
  return import(pathToFileURL(out).href);
}

const { commissionRateFor, TARIFFS } = await load('src/services/analytics/commission.js');
const { guessInstrumentType } = await load('src/services/import/instrumentResolver.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${actual}${ok ? '' : ` (ожидалось ${expected})`}`);
  if (!ok) failed += 1;
}

// --- тип инструмента по коду тикера ---
check('SVCB — обычная акция', guessInstrumentType('SVCB'), 'stock');
check('SBER — обычная акция', guessInstrumentType('SBER'), 'stock');
check('GAZPF — вечный фьючерс', guessInstrumentType('GAZPF'), 'future');
check('IMOEXF — вечный фьючерс', guessInstrumentType('IMOEXF'), 'future');
check('GZU5 — классический фьючерс', guessInstrumentType('GZU5'), 'future');
check('CNYRUB_TOM — валютная пара', guessInstrumentType('CNYRUB_TOM'), 'currency');

// --- ТОТ САМЫЙ БАГ: акция не должна считаться по фьючерсной ставке ---
const svcb = commissionRateFor('trader', guessInstrumentType('SVCB'));
check('SVCB на «Трейдере» — ставка акций 0.05%', svcb.rate, 0.0005);
check('SVCB на «Трейдере» — ставка точная, не прикидка', svcb.approx, false);

// Контроль: у фьючерса на том же тарифе ставка ДРУГАЯ — если эти два числа совпадут,
// тест перестанет что-либо ловить.
const gazpf = commissionRateFor('trader', guessInstrumentType('GAZPF'));
check('GAZPF на «Трейдере» — ставка фьючерсов 0.04%', gazpf.rate, 0.0004);
if (svcb.rate === gazpf.rate) {
  console.log('✗ ставки акции и фьючерса совпали — тест потерял смысл');
  failed += 1;
} else {
  console.log('✓ ставки акции и фьючерса на «Трейдере» различаются');
}

// --- остальные тарифы по акциям ---
check('Акция на «Инвесторе» — 0.3%', commissionRateFor('investor', 'stock').rate, 0.003);
check('Акция на «Премиуме» — 0.04%', commissionRateFor('premium', 'stock').rate, 0.0004);

// --- валюта: подтверждена официальным тарифом, прикидкой больше не помечается ---
const traderCurrency = commissionRateFor('trader', 'currency');
check('Валюта на «Трейдере» — 0.5%', traderCurrency.rate, 0.005);
check('Валюта на «Трейдере» — ставка подтверждённая, не прикидка', traderCurrency.approx, false);
check('Валюта на «Премиуме» — 0.4%', commissionRateFor('premium', 'currency').rate, 0.004);

// --- лестница по обороту за день: «Трейдер» ---
const ladder = (turnover) => commissionRateFor('trader', 'future', { dayTurnoverRub: turnover }).rate;
check('Трейдер, оборот не указан — верхняя ступень 0.040%', commissionRateFor('trader', 'future').rate, 0.0004);
check('Трейдер, оборот 1 млн — 0.040%', ladder(1_000_000), 0.0004);
check('Трейдер, ровно 5 млн (включительно) — ещё 0.040%', ladder(5_000_000), 0.0004);
check('Трейдер, 5 млн + рубль — уже 0.03%', ladder(5_000_001), 0.0003);
check('Трейдер, ровно 10 млн (включительно) — 0.03%', ladder(10_000_000), 0.0003);
check('Трейдер, свыше 10 млн — 0.025%', ladder(20_000_000), 0.00025);

// --- лестница по обороту за день: «Премиум», пороги другие ---
const premLadder = (t) => commissionRateFor('premium', 'future', { dayTurnoverRub: t }).rate;
check('Премиум, 1 млн — 0.025%', premLadder(1_000_000), 0.00025);
check('Премиум, ровно 12 млн — 0.025%', premLadder(12_000_000), 0.00025);
check('Премиум, 15 млн — 0.02%', premLadder(15_000_000), 0.0002);
check('Премиум, свыше 17 млн — 0.015%', premLadder(20_000_000), 0.00015);
check('Премиум, фьючерсы — ставка подтверждена, не прикидка',
  commissionRateFor('premium', 'future').approx, false);

// --- фьючерсы из «Дополнительного списка»: фиксированная ставка, оборот не важен ---
const extra = commissionRateFor('trader', 'future', { extraList: true, dayTurnoverRub: 50_000_000 });
check('Доп. список на «Трейдере» — 0.08% независимо от оборота', extra.rate, 0.0008);

// --- пояснение про лестницу остаётся, когда оборот неизвестен ---
const traderFuture = commissionRateFor('trader', 'future');
check(
  'Фьючерс на «Трейдере» без оборота — есть пояснение про лестницу',
  typeof traderFuture.note === 'string' && traderFuture.note.includes('оборот'),
  true,
);

// --- в каталоге тарифов ровно те три, что есть у Т-Банка ---
check('Тарифов в каталоге — три', Object.keys(TARIFFS).length, 3);

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки комиссии прошли ✓');
