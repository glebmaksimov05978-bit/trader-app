// Регресс-тест: роботы должны уметь писать документы с полями undefined (npm run test:undefined).
// Без ignoreUndefinedProperties Firestore Admin отвергает такой документ ещё до отправки в сеть —
// из-за этого бумажные сделки не открывались ни разу. Сеть не нужна: проверяется только момент
// проверки документа; если запрос «ушёл» в сеть (таймаут), значит проверку документ прошёл.
import admin from 'firebase-admin';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
async function tryAdd(db) {
  try {
    await Promise.race([db.collection('t').add({ a: 1, b: undefined }), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 2500))]);
    return 'accepted';
  } catch (e) {
    // Проверка документа идёт ДО сети: любая другая ошибка (таймаут, «нет учётных данных») значит,
    // что документ валидацию прошёл. Отвергнутый undefined узнаётся по слову в тексте.
    return /undefined/.test(e.message) ? e.message : 'accepted';
  }
}
const rawApp = admin.initializeApp({ projectId: 'demo-a' }, 'a');
const raw = await tryAdd(rawApp.firestore());
ok('без настройки undefined отвергается (подтверждает саму ловушку)', /undefined/.test(raw));
const fixedApp = admin.initializeApp({ projectId: 'demo-b' }, 'b');
const fixedDb = fixedApp.firestore();
fixedDb.settings({ ignoreUndefinedProperties: true });
ok('с ignoreUndefinedProperties документ проходит проверку', (await tryAdd(fixedDb)) === 'accepted');
// Все четыре робота обязаны включать настройку.
import fs from 'fs';
for (const f of ['scripts/paper/runPaperTrades.mjs', 'scripts/paper/managePaperTrades.mjs', 'scripts/alerts/runAlerts.mjs', 'scripts/telegram/writeSnapshot.mjs', 'scripts/telegram/applyFills.mjs', 'scripts/radar/cleanupRadar.mjs']) {
  ok(`${f}: настройка включена`, fs.readFileSync(f, 'utf8').includes('ignoreUndefinedProperties: true'));
}
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки записи в Firestore прошли ✓');
process.exit(0);
