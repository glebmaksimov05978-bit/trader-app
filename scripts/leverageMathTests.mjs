// Проверка плеча и «сколько можно купить на мои деньги» (npm run test:leverage). Сеть не нужна.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-lev-'));
fs.writeFileSync(path.join(tmp, 'leverageMath.js'), fs.readFileSync(path.join(__dirname, '../src/services/leverageMath.js'), 'utf8'));
const L = await import(pathToFileURL(path.join(tmp, 'leverageMath.js')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// --- подпись плеча: не «рябит» от тиков
ok('плечо 8,98 → «9×» (не 8,98)', L.leverageText(8.98) === '9×');
ok('плечо 9,04 → тоже «9×» — от тика к тику подпись не дёргается', L.leverageText(9.04) === '9×' && L.leverageText(8.6) === '9×');
ok('малое плечо — с десятой: 4,26 → «4,3×»; 12,4 → «12×»', L.leverageText(4.26) === '4,3×' && L.leverageText(12.4) === '12×');
ok('нет плеча → пустая строка, не «NaN×»', L.leverageText(0) === '' && L.leverageText(NaN) === '' && L.leverageText(null) === '');
ok('значение для записи в сделку совпадает с подписью', L.leverageValue(8.98) === 9 && L.leverageValue(4.26) === 4.3 && L.leverageValue(0) === null);
ok('плечо = стоимость / ГО; 0, если нечего считать', near(L.leverageOf(24691.5, 2750.56), 8.9769, 1e-3) && L.leverageOf(0, 100) === 0 && L.leverageOf(100, 0) === 0);

// --- что можно купить на мои деньги (MXI: стоимость контракта 24 691,5 ₽, ГО лонг 2 750,56, шорт 3 300)
const cap = L.capacityByDirection({ deposit: 300000, maxMarginPercent: 30, marginBuy: 2750.56, marginSell: 3300, valueRub: 24691.5 });
ok('лонг: по лимиту 30 % депозита (90 000 ₽) — до 32 контрактов', cap.long.maxByLimit === 32);
ok('шорт считается по СВОЕМУ ГО (3 300 ₽) — до 27, а не 32', cap.short.maxByLimit === 27);
ok('предел «весь депозит под ГО»: лонг 109', cap.long.maxPhysical === 109);
ok('плечо по сторонам: лонг ≈ 9×, шорт ≈ 7×', L.leverageText(cap.long.leverage) === '9×' && L.leverageText(cap.short.leverage) === '7×');
ok('один контракт занимает ≈ 0,9 % депозита', near(cap.long.oneUsesPct, 0.9169, 1e-3));
ok('строка «на ваши деньги»', L.capacityLine(cap) === 'лонг до 32 контр. · шорт до 27 контр.');
const small = L.capacityByDirection({ deposit: 50000, maxMarginPercent: 30, marginBuy: 17209.89, marginSell: 17209.89, valueRub: 77000 });
ok('мало денег: по лимиту 30 % не хватает даже на один контракт — так и сказано', small.long.maxByLimit === 0 && /лонг: не хватает денег/.test(L.capacityLine(small)) && small.long.maxPhysical === 2);
ok('нет ГО шорта — берётся ГО лонга', L.capacityByDirection({ deposit: 100000, marginBuy: 5000, valueRub: 40000 }).short.margin === 5000);
ok('нет депозита или ГО → null (нечего показывать)', L.capacityByDirection({ deposit: 0, marginBuy: 5000, valueRub: 1 }) === null && L.capacityByDirection({ deposit: 1e5, marginBuy: 0, valueRub: 1 }) === null && L.capacityLine(null) === '');
ok('лимит по умолчанию 30 %, если не задан или кривой', L.capacityByDirection({ deposit: 1e5, marginBuy: 3000, valueRub: 1, maxMarginPercent: 'x' }).maxMarginPercent === 30);

// --- доходность на ГО
ok('+1 000 ₽ при ГО 5 000 ₽ → +20 % от ГО; без ГО → null', near(L.returnOnMarginPct(1000, 5000), 20) && L.returnOnMarginPct(1000, 0) === null && near(L.returnOnMarginPct(-250, 5000), -5));
ok('ход цены 1 % при плече 9× → 9 % от ГО', near(L.movePctOnMargin(1, 9), 9) && L.movePctOnMargin(1, 0) === null);

// --- плечо сделки из журнала
const stored = { instrumentType: 'future', volume: 3, marginPerContract: 2750.56, leverageAtEntry: 9, marginSource: 'moex', entryPrice: 2469 };
const tl = L.tradeLeverage(stored);
ok('записанное при открытии плечо берётся как есть; ГО под позицию = ГО × объём', tl.leverage === 9 && tl.stored === true && near(tl.marginTotal, 8251.68, 1e-2) && tl.source === 'moex');
const old = { instrumentType: 'future', volume: 2, marginPerContract: 2750.56, entryPrice: 2469.15, minStep: 0.05, minStepAmount: 0.5 };
ok('у старой сделки плечо восстанавливается по цене входа, шагу и ГО', near(L.tradeLeverage(old).leverage, 24691.5 / 2750.56, 1e-3) && L.tradeLeverage(old).stored === false);
ok('нет ни плеча, ни ГО → null; акция → null', L.tradeLeverage({ instrumentType: 'future', volume: 1, entryPrice: 100 }) === null && L.tradeLeverage({ instrumentType: 'stock', volume: 10, leverageAtEntry: 3 }) === null && L.tradeLeverage(null) === null);

// --- линейка на графике: рубли на контракт и % от ГО
const stats = { delta: 100, pct: 4.05 };
const ctr = { rubPerPoint: 10, margin: 2750.56, startPrice: 2469 };
const rt = L.rulerContractText(stats, ctr);
ok('линейка: +100 пунктов MXI = +1 000 ₽ на контракт = +36 % от ГО, плечо 9×', /^≈ \+1\s?000 ₽ на контракт · \+36 % от ГО \(плечо 9×\)$/.test(rt));
ok('линейка вниз: знак «−»', /^≈ −1\s?000 ₽ на контракт · −36 % от ГО/.test(L.rulerContractText({ delta: -100 }, ctr)));
ok('линейка без ГО: только рубли; без данных контракта — пусто', L.rulerContractText(stats, { rubPerPoint: 10, margin: 0 }) === '≈ +1 000 ₽ на контракт' || /^≈ \+1\s?000 ₽ на контракт$/.test(L.rulerContractText(stats, { rubPerPoint: 10, margin: 0 })));
ok('…и пусто, если нет стоимости пункта', L.rulerContractText(stats, { rubPerPoint: 0, margin: 5 }) === '' && L.rulerContractText(null, ctr) === '' && L.rulerContractText(stats, null) === '');

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки прошли');
process.exitCode = fails ? 1 : 0;
