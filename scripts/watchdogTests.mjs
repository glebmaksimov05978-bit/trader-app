import { decide, formatWatchdogMessage } from './alerts/watchdog.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL:', name); } };

const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 29, h - 3, m)); // время по Москве
const run = (h, m, event = 'workflow_dispatch') => ({ event, created_at: at(h, m).toISOString() });

ok('будильник был 10 мин назад — молчим', !decide({ now: at(12, 10), runs: [run(12, 0)], lastAlertAt: null }).alert);
ok('тишина 2 часа — предупреждаем', decide({ now: at(14, 0), runs: [run(12, 0)], lastAlertAt: null }).alert);
ok('только запуски по расписанию GitHub — предупреждаем', decide({ now: at(14, 0), runs: [run(13, 50, 'schedule')], lastAlertAt: null }).alert);
ok('запусков нет вовсе — предупреждаем', decide({ now: at(14, 0), runs: [], lastAlertAt: null }).alert);
ok('ночью не тревожим', !decide({ now: at(3, 0), runs: [], lastAlertAt: null }).alert);
ok('после 22:00 не тревожим', !decide({ now: at(22, 30), runs: [], lastAlertAt: null }).alert);
ok('не повторяем чаще 3 часов', !decide({ now: at(14, 0), runs: [], lastAlertAt: at(12, 30).getTime() }).alert);
ok('повторяем через 3 часа', decide({ now: at(15, 40), runs: [], lastAlertAt: at(12, 30).getTime() }).alert);
ok('граница 60 минут', decide({ now: at(13, 0), runs: [run(12, 0)], lastAlertAt: null }).alert);
ok('59 минут — ещё норма', !decide({ now: at(12, 59), runs: [run(12, 0)], lastAlertAt: null }).alert);

const m = formatWatchdogMessage(150);
ok('в тексте часы', /2 ч назад/.test(m));
ok('в тексте минуты', /45 мин назад/.test(formatWatchdogMessage(45)));
ok('нет запусков вовсе', /нет вовсе/.test(formatWatchdogMessage(null)));

console.log(`watchdog: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
