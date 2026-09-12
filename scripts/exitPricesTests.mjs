// scripts/exitPricesTests.mjs
//
// Проверка цен выхода из services/analytics/exitRules.js: npm run test:exits
//
// Главное, что здесь проверяется, — СТОРОНА цены относительно входа. В лонге цель выше
// входа и стоп ниже, в шорте наоборот. Звучит очевидно, но именно здесь был реальный баг:
// тип «У уровня» берёт ближайший уровень из разметки, а разметка отсортирована вокруг
// ТЕКУЩЕЙ цены, а не цены входа, — и в шорт подставлялась цель ВЫШЕ входа, то есть точка
// «зафиксировать прибыль» стояла там, где сделка на самом деле в убытке (жалоба трейдера).
// У стопа такая проверка была с самого начала, у цели её не было.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-exits-'));

// exitRules.js вообще ни от чего не зависит (ни одного import) — достаточно скопировать
// его под расширением .mjs, чтобы Node прочитал его как модуль. Никаких заглушек.
const src = path.join(repoRoot, 'src', 'services', 'analytics', 'exitRules.js');
const copy = path.join(tmp, 'exitRules.mjs');
fs.writeFileSync(copy, fs.readFileSync(src, 'utf8'), 'utf8');
const { computeTakePrice, computeStopPrice } = await import(pathToFileURL(copy).href);

let failed = 0;
function check(name, actual, expect) {
  const ok = expect(actual);
  console.log(`${ok ? '✓' : '✗'} ${name}: ${actual === null ? 'null' : Number(actual).toFixed(2)}`);
  if (!ok) failed += 1;
}

const ENTRY = 100;

// --- проценты: самая простая форма, обе стороны ---
check(
  'Лонг, цель 3% — выше входа',
  computeTakePrice('long', ENTRY, { takeType: 'pct', takePct: 3 }, {}),
  (v) => Math.abs(v - 103) < 1e-9,
);
check(
  'Шорт, цель 3% — ниже входа',
  computeTakePrice('short', ENTRY, { takeType: 'pct', takePct: 3 }, {}),
  (v) => Math.abs(v - 97) < 1e-9,
);

// --- ТОТ САМЫЙ БАГ: уровень пришёл не с той стороны от входа ---
// Шорт от 100, а ближайшая поддержка в разметке — 105, ВЫШЕ входа. Раньше она уезжала
// прямо в тейк. Теперь такая цена отбраковывается и берётся запасной процент трейдера.
const wrongSideCtx = { patterns: { supportResistance: [{ type: 'support', price: 105 }] } };
check(
  'Шорт, уровень выше входа — цель НЕ выше входа',
  computeTakePrice('short', ENTRY, {
    takeType: 'level', takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  }, wrongSideCtx),
  (v) => v !== null && v < ENTRY && Math.abs(v - 96) < 1e-9,
);

// Уровень с ПРАВИЛЬНОЙ стороны по-прежнему используется как есть (не сломали обычный путь).
const rightSideCtx = { patterns: { supportResistance: [{ type: 'resistance', price: 110 }] } };
check(
  'Лонг, сопротивление 110 — цель между входом и уровнем',
  computeTakePrice('long', ENTRY, {
    takeType: 'level', takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  }, rightSideCtx),
  (v) => v > ENTRY && v < 110,
);

// --- «Нет» — это осознанный выбор, а не пропущенное значение ---
check(
  'takeType "none" — цели нет, запасная цепочка её не выдумывает',
  computeTakePrice('short', ENTRY, { takeType: 'none', takeLevelFallbackPct: 4 }, { atr: 2 }),
  (v) => v === null,
);

// --- стоп не трогали: контрольная проверка обеих сторон ---
check(
  'Шорт, стоп 2% — выше входа',
  computeStopPrice('short', ENTRY, { stopType: 'pct', stopPct: 2 }, {}),
  (v) => Math.abs(v - 102) < 1e-9,
);
check(
  'Лонг, стоп 2% — ниже входа',
  computeStopPrice('long', ENTRY, { stopType: 'pct', stopPct: 2 }, {}),
  (v) => Math.abs(v - 98) < 1e-9,
);

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки цен выхода прошли ✓');
