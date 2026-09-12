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

// --- неподтверждённые ставки честно помечаются прикидкой ---
const premiumFuture = commissionRateFor('premium', 'future');
check('Фьючерс на «Премиуме» — ставка не подтверждена, помечена прикидкой', premiumFuture.approx, true);

// --- фьючерсы на «Трейдере» несут пояснение про лестницу оборота ---
const traderFuture = commissionRateFor('trader', 'future');
check(
  'Фьючерс на «Трейдере» — есть пояснение про лестницу оборота',
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
