// Проверка автоочистки радара (npm run test:radarclean). Сеть не нужна.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-clean-'));
const md = path.join(__dirname, '../src/services/marketData');
for (const f of ['candles.js', 'futuresRoll.js', 'radarCleanup.js']) fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(md, f), 'utf8').replace("from '../tinkoff'", "from './tinkoff.js'"));
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
const roll = await import(pathToFileURL(path.join(tmp, 'futuresRoll.js')).href);
const { planRadarCleanup } = await import(pathToFileURL(path.join(tmp, 'radarCleanup.js')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

ok('MMU5 → корень MM', roll.rootTickerOfContract('MMU5') === 'MM');
ok('BRX6 → BR, SiZ6 → SI, SBERF → null (вечный)', roll.rootTickerOfContract('BRX6') === 'BR' && roll.rootTickerOfContract('SiZ6') === 'SI' && roll.rootTickerOfContract('SBERF') === null);

const big = (n, pre) => new Set(Array.from({ length: n }, (_, i) => `${pre}${i}`));
const stocks = big(300, 'S'); stocks.add('SBER'); stocks.add('GAZP');
const futs = big(80, 'F'); ['SBERF', 'IMOEXF', 'BRZ6', 'MXZ6'].forEach((x) => futs.add(x));
const item = (id, ticker, type) => ({ id, ticker, instrumentType: type });
const base = [item('1', 'SBER', 'stock'), item('2', 'GAZP', 'stock'), item('3', 'SBERF', 'future'), item('4', 'BR', 'future'), item('5', 'IMOEXF', 'future')];

ok('живые записи не трогаются', planRadarCleanup(base, { stockSecids: stocks, futureSecids: futs }).actions.length === 0);

let r = planRadarCleanup([...base, item('6', 'MMU5', 'future')], { stockSecids: stocks, futureSecids: futs });
ok('истёкший MMU5 заменяется на MM', r.actions.length === 1 && r.actions[0].action === 'replace' && r.actions[0].to === 'MM');

r = planRadarCleanup([...base, item('6', 'VTBRF', 'future')], { stockSecids: stocks, futureSecids: futs });
ok('несуществующий VTBRF убирается', r.actions.length === 1 && r.actions[0].action === 'remove');

r = planRadarCleanup([...base, item('6', 'MMU5', 'future'), item('7', 'MM', 'future')], { stockSecids: stocks, futureSecids: futs });
ok('если корень MM уже есть — просто убираем дубль', r.actions.length === 1 && r.actions[0].action === 'remove' && r.actions[0].id === '6');

r = planRadarCleanup([...base, item('6', 'MMU5', 'future'), item('7', 'MMZ5', 'future')], { stockSecids: stocks, futureSecids: futs });
ok('два истёкших контракта одного корня → один корень, второй убран', r.actions.filter((a) => a.action === 'replace').length === 1 && r.actions.filter((a) => a.action === 'remove').length === 1);

r = planRadarCleanup([...base, item('6', 'FIXP', 'stock')], { stockSecids: stocks, futureSecids: futs, stockStatus: new Map([['FIXP', 'dead']]) });
ok('снятая с торгов акция убирается', r.actions.length === 1 && r.actions[0].ticker === 'FIXP');

r = planRadarCleanup([...base, item('6', 'IMOEX', 'stock')], { stockSecids: stocks, futureSecids: futs, stockStatus: new Map([['IMOEX', 'traded']]) });
ok('индекс/бумага, торгуемая на другой площадке, не трогается', r.actions.length === 0);
r = planRadarCleanup([...base, item('6', 'ZZZZ', 'stock')], { stockSecids: stocks, futureSecids: futs });
ok('статус акции неизвестен → не трогаем', r.actions.length === 0);

ok('список бумаг не загрузился → ничего не делаем', planRadarCleanup([item('1', 'FIXP', 'stock'), item('2', 'VTBRF', 'future')], { stockSecids: null, futureSecids: null, stockStatus: new Map([['FIXP', 'dead']]) }).actions.length === 0);
ok('подозрительно короткий список → ничего', planRadarCleanup([item('1', 'VTBRF', 'future')], { stockSecids: stocks, futureSecids: new Set(['A']) }).actions.length === 0);
r = planRadarCleanup([item('1', 'AAA1', 'future'), item('2', 'BBB1', 'future'), item('3', 'SBER', 'stock')], { stockSecids: stocks, futureSecids: futs });
ok('больше половины радара к удалению → отказ', r.actions.length === 0 && /больше половины/.test(r.aborted || ''));
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки автоочистки радара прошли ✓');
