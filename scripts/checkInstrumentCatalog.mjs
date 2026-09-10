// scripts/checkInstrumentCatalog.mjs
//
// Сверка встроенного каталога инструментов с реальной биржей.
//
// Каталог в src/services/marketData/instrumentCatalog.js — ручной: у записей есть сектор
// и человеческое название, которых в выгрузке MOEX нет, поэтому автогенерация сделала бы
// список хуже. Но биржа живёт своей жизнью: бумаги переименовывают (редомициляции),
// делистят, добавляют новые ликвидные имена. Этот скрипт не переписывает файл, а
// показывает расхождения — что чинить руками:
//
//   node scripts/checkInstrumentCatalog.mjs
//
// Требует доступ к iss.moex.com (публичный, без ключей).
import { CATALOG } from '../src/services/marketData/instrumentCatalog.js';

const ISS = 'https://iss.moex.com/iss';

async function jsonOf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function rowsOf(block, wanted) {
  const cols = block?.columns || [];
  const idx = wanted.map((c) => cols.indexOf(c));
  return (block?.data || []).map((row) => Object.fromEntries(wanted.map((c, k) => [c, row[idx[k]]])));
}

const shares = rowsOf(
  (await jsonOf(`${ISS}/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off`
    + `&securities.columns=SECID,SHORTNAME&marketdata.columns=SECID,VALTODAY`)).securities,
  ['SECID', 'SHORTNAME'],
);
const sharesLive = rowsOf(
  (await jsonOf(`${ISS}/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off`
    + `&marketdata.columns=SECID,VALTODAY`)).marketdata,
  ['SECID', 'VALTODAY'],
);
const futures = rowsOf(
  (await jsonOf(`${ISS}/engines/futures/markets/forts/securities.json?iss.meta=off`
    + `&securities.columns=SECID,SHORTNAME`)).securities,
  ['SECID', 'SHORTNAME'],
);

const onExchange = new Map();
for (const s of shares) onExchange.set(s.SECID, s.SHORTNAME);
for (const f of futures) onExchange.set(f.SECID, f.SHORTNAME);

const turnover = new Map(sharesLive.map((r) => [r.SECID, r.VALTODAY || 0]));

console.log(`На бирже: ${shares.length} акций (TQBR), ${futures.length} фьючерсов`);
console.log(`В каталоге: ${CATALOG.length}\n`);

const missing = CATALOG.filter((i) => !onExchange.has(i.ticker));
if (missing.length) {
  console.log('НЕТ НА БИРЖЕ (переименовано или делистинг) — проверить руками:');
  for (const i of missing) console.log(`  ${i.ticker.padEnd(8)} ${i.name}`);
} else {
  console.log('Все тикеры каталога есть на бирже ✓');
}

// Что стоило бы добавить: ликвидные бумаги, которых в каталоге нет. Порог по обороту
// отсекает неторгуемый хвост доски — каталог для того и нужен, чтобы показывать то,
// чем действительно торгуют.
const inCatalog = new Set(CATALOG.map((i) => i.ticker));
const candidates = shares
  .filter((s) => !inCatalog.has(s.SECID) && (turnover.get(s.SECID) || 0) > 50_000_000)
  .sort((a, b) => (turnover.get(b.SECID) || 0) - (turnover.get(a.SECID) || 0));

if (candidates.length) {
  console.log('\nЛИКВИДНЫЕ, НО НЕ В КАТАЛОГЕ (оборот сегодня > 50 млн ₽):');
  for (const c of candidates) {
    const v = Math.round((turnover.get(c.SECID) || 0) / 1e6);
    console.log(`  ${c.SECID.padEnd(8)} ${String(c.SHORTNAME).padEnd(26)} ${v} млн ₽`);
  }
} else {
  console.log('\nЛиквидных бумаг вне каталога не нашлось ✓');
}

// Названия сверяем мягко: биржевое SHORTNAME («Сбербанк» vs «Сбербанк России») не обязано
// совпадать с нашим, но полное расхождение — повод посмотреть, не переименовали ли бумагу.
const suspicious = CATALOG.filter((i) => {
  const short = onExchange.get(i.ticker);
  if (!short) return false;
  const a = i.name.toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
  const b = String(short).toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
  return !a.includes(b.slice(0, 5)) && !b.includes(a.slice(0, 5));
});
if (suspicious.length) {
  console.log('\nНАЗВАНИЯ РАСХОДЯТСЯ (может быть переименование):');
  for (const i of suspicious) console.log(`  ${i.ticker.padEnd(8)} у нас "${i.name}" / на бирже "${onExchange.get(i.ticker)}"`);
}
