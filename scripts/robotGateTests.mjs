// Проверка ворот прохода робота (npm run test:gate): когда второй проход после «удара» будильников пропускается. Сеть не нужна.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { decideSkip, TWIN_WINDOW_MS } = await import(pathToFileURL(path.join(__dirname, 'alerts/gate.mjs')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// Реальная картина 2026-11-09: два запуска с разницей в 15 секунд, каждые 15 минут.
const run = (id, iso, status = 'completed', conclusion = 'success') => ({ id, created_at: iso, status, conclusion });
const runs = [
  run(6618, '2026-11-09T17:30:29Z', 'in_progress', null),
  run(6617, '2026-11-09T17:30:14Z'),
  run(6616, '2026-11-09T17:15:29Z'),
  run(6615, '2026-11-09T17:15:10Z'),
  run(6614, '2026-11-09T17:00:29Z'),
  run(6613, '2026-11-09T17:00:22Z'),
];
ok('второй запуск пары (6618, создан через 15 с после 6617) — пропускается', decideSkip({ runs, runId: 6618 }).skip === true);
ok('первый запуск пары (6617): раньше него в пределах 4 минут ничего нет — работает', decideSkip({ runs, runId: 6617 }).skip === false);
ok('запуск следующего «удара» (через 15 минут) не пропускается', decideSkip({ runs: [run(6620, '2026-11-09T17:45:10Z', 'in_progress', null), ...runs], runId: 6620 }).skip === false);
ok('соседний запуск ещё идёт (не завершён) — не пропускаем, чтобы не остаться вообще без прохода', decideSkip({ runs: [run(7, '2026-11-09T10:00:20Z', 'in_progress', null), run(6, '2026-11-09T10:00:10Z', 'in_progress', null)], runId: 7 }).skip === false);
ok('соседний запуск упал (failure) — это тоже «проход был», пропускаем', decideSkip({ runs: [run(9, '2026-11-09T10:00:20Z', 'in_progress', null), run(8, '2026-11-09T10:00:10Z', 'completed', 'failure')], runId: 9 }).skip === true);
ok('отменённый соседний запуск не считается проходом', decideSkip({ runs: [run(9, '2026-11-09T10:00:20Z', 'in_progress', null), run(8, '2026-11-09T10:00:10Z', 'completed', 'cancelled')], runId: 9 }).skip === false);
ok('сосед создан ровно на границе окна (4 мин) — уже не «тот же удар»', decideSkip({ runs: [run(9, '2026-11-09T10:04:10Z', 'in_progress', null), run(8, '2026-11-09T10:00:10Z')], runId: 9, windowMs: TWIN_WINDOW_MS }).skip === false);
ok('три будильника: третий пропускается, первый — нет', (() => {
  const three = [run(3, '2026-11-09T10:00:50Z', 'in_progress', null), run(2, '2026-11-09T10:00:29Z'), run(1, '2026-11-09T10:00:08Z')];
  return decideSkip({ runs: three, runId: 3 }).skip === true && decideSkip({ runs: three, runId: 1 }).skip === false;
})());
ok('более новые запуски (id больше) никогда не причина пропуска', decideSkip({ runs: [run(5, '2026-11-09T10:00:10Z', 'in_progress', null), run(6, '2026-11-09T10:00:20Z')], runId: 5 }).skip === false);
ok('своего запуска нет в списке / пустой список / кривая дата — не пропускаем', decideSkip({ runs, runId: 1 }).skip === false && decideSkip({ runs: [], runId: 1 }).skip === false && decideSkip({ runs: [run(1, 'вчера')], runId: 1 }).skip === false && decideSkip({ runs: null, runId: 1 }).skip === false);

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки прошли');
process.exitCode = fails ? 1 : 0;
