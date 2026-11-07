// Проверка игры «Увидеть фигуру» (npm run test:trainer): раунды воспроизводимы, варианты ответа корректны,
// очки и серии считаются, слабые места и путаница находятся, сравнение с детектором работает.
import {
  buildRound, splitRound, LEVELS, levelForXp, nextLevel, emptyProgress, applyAnswer, progressSummary,
  compareWithDetector, THEORY, NONE_ID, DETECTOR_ACCEPT, XP_CORRECT,
} from '../src/services/trainer/patternQuiz.js';
import { PATTERN_IDS } from '../src/services/trainer/patternGenerator.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// Теория есть у каждой фигуры и у «пусто»; таблица детекторов покрывает все фигуры.
ok('теория описана для всех фигур и для «фигуры нет»', [...PATTERN_IDS, NONE_ID].every((id) => THEORY[id]?.name && THEORY[id].look && THEORY[id].logic && THEORY[id].trap));
ok('таблица ответов детектора покрывает все фигуры', PATTERN_IDS.every((id) => Array.isArray(DETECTOR_ACCEPT[id]) && DETECTOR_ACCEPT[id].length));

// Раунды воспроизводимы и корректны на всех уровнях.
let allOk = true, noneSeen = 0, noneBeforeL3 = 0, total = 0;
for (const level of LEVELS) {
  for (let seed = 1; seed <= 120; seed++) {
    const r1 = buildRound({ levelId: level.id, seed });
    const r2 = buildRound({ levelId: level.id, seed });
    if (JSON.stringify(r1) !== JSON.stringify(r2)) allOk = false;
    if (!r1.options.includes(r1.truth)) allOk = false;                          // верный ответ всегда среди вариантов
    if (new Set(r1.options).size !== r1.options.length) allOk = false;          // без повторов
    if (r1.options.length < 2 || r1.options.length > level.options + 1) allOk = false;
    if (!level.withNone && r1.options.includes(NONE_ID)) noneBeforeL3++;       // «пусто» только с 3-го уровня
    if (r1.truth === NONE_ID) { noneSeen++; if (r1.direction !== null) allOk = false; }
    if (r1.truth !== NONE_ID && !level.patterns.includes(r1.truth)) allOk = false;
    const { visible, hidden } = splitRound(r1);
    if (visible.length !== r1.cut + 1 || !hidden.length || visible.length + hidden.length !== r1.candles.length) allOk = false;
    total++;
  }
}
ok('раунды воспроизводимы; верный ответ среди вариантов, без повторов; «пусто» только с 3-го уровня; видимая и скрытая части сходятся', allOk && noneBeforeL3 === 0);
ok('на уровнях с «пусто» оно действительно встречается (около 18 % раундов)', noneSeen > 10 && noneSeen < total * 0.3);
ok('разные семена дают разные графики', JSON.stringify(buildRound({ levelId: 2, seed: 1 }).candles) !== JSON.stringify(buildRound({ levelId: 2, seed: 2 }).candles));

// Очки: 10 за верный ответ; серия с третьего ответа даёт бонус; ошибка обнуляет серию и пишет путаницу.
let p = emptyProgress();
const round = buildRound({ levelId: 1, seed: 5 });
const wrong = round.options.find((o) => o !== round.truth);
let res = applyAnswer(p, round, round.truth); p = res.progress;
ok('верный ответ даёт 10 очков и серию 1', res.correct && res.gained === XP_CORRECT && p.xp === XP_CORRECT && p.streak === 1);
res = applyAnswer(p, round, round.truth); p = res.progress;
res = applyAnswer(p, round, round.truth); p = res.progress;
ok('с третьего подряд ответа есть бонус', res.gained > XP_CORRECT && p.streak === 3 && p.bestStreak === 3);
res = applyAnswer(p, round, wrong); p = res.progress;
ok('ошибка обнуляет серию, очки не отнимает, путаница записана', !res.correct && res.gained === 0 && p.streak === 0 && p.bestStreak === 3 && p.confusions[`${round.truth}>${wrong}`] === 1 && p.answered === 4 && p.correct === 3);
const frozen = JSON.stringify(p);
applyAnswer(p, round, round.truth);
ok('исходный прогресс не меняется (чистая функция)', JSON.stringify(p) === frozen);

// Уровни по очкам.
ok('уровень растёт с очками', levelForXp(0).id === 1 && levelForXp(100).id === 2 && levelForXp(299).id === 2 && levelForXp(600).id === 4 && nextLevel(0).id === 2 && nextLevel(9999) === null);

// Сводка: слабые фигуры (n ≥ 5) и частая путаница (n ≥ 3).
let q = emptyProgress();
const rA = buildRound({ levelId: 1, seed: 11 });
const wrongA = rA.options.find((o) => o !== rA.truth);
for (let i = 0; i < 6; i++) q = applyAnswer(q, rA, wrongA).progress;
for (let i = 0; i < 2; i++) q = applyAnswer(q, rA, rA.truth).progress;
const sum = progressSummary(q);
ok('слабая фигура найдена по 5+ раундам', sum.weak.length === 1 && sum.weak[0].id === rA.truth && sum.weak[0].n === 8 && Math.abs(sum.weak[0].accuracy - 0.25) < 1e-9);
ok('частая путаница найдена (3+ раза)', sum.topConfusion && sum.topConfusion.truth === rA.truth && sum.topConfusion.answer === wrongA && sum.topConfusion.n === 6);
const sum0 = progressSummary(emptyProgress());
// Слабые места — только там, где точность действительно низкая (раньше в них попадали и фигуры со 100 %)
{
  let pr = emptyProgress();
  const r1 = buildRound({ levelId: 1, seed: 11 });
  for (let i = 0; i < 6; i++) pr = applyAnswer(pr, r1, r1.truth).progress;
  const s1 = progressSummary(pr);
  ok('безошибочная фигура (6 из 6) не считается слабым местом', s1.weak.length === 0);
  const r2 = buildRound({ levelId: 1, seed: 12 });
  const wrong = r2.options.find((o) => o !== r2.truth);
  for (let i = 0; i < 4; i++) pr = applyAnswer(pr, r2, r2.truth).progress;
  for (let i = 0; i < 2; i++) pr = applyAnswer(pr, r2, wrong).progress;
  const s2 = progressSummary(pr);
  ok('фигура с 4 из 6 (67 %) — слабое место, а безошибочная рядом — нет', s2.weak.length === 1 && s2.weak[0].id === r2.truth);
  const r3 = buildRound({ levelId: 1, seed: 13 });
  for (let i = 0; i < 4; i++) pr = applyAnswer(pr, r3, r3.truth).progress;
  for (let i = 0; i < 1; i++) pr = applyAnswer(pr, r3, r3.options.find((o) => o !== r3.truth)).progress;
  ok('4 из 5 (80 %) — уже не слабое место (порог — ниже 80 %)', !progressSummary(pr).weak.some((w) => w.id === r3.truth && r3.truth !== r2.truth));
}
ok('пустой прогресс: точность неизвестна, слабых мест нет', sum0.accuracy === null && sum0.weak.length === 0 && sum0.topConfusion === null);

// Сравнение с детектором.
const rf = { truth: 'flag_bull' };
let c = compareWithDetector(rf, 'flag_bull', [{ pattern: 'double_top', confidence: 80 }, { pattern: 'flag_descending', confidence: 60 }]);
ok('нужная фигура среди кандидатов, но не главная', c.human && c.detectorFound && !c.detectorTopRight && c.detectorTop.pattern === 'double_top');
c = compareWithDetector({ truth: NONE_ID }, NONE_ID, [{ pattern: 'double_bottom', confidence: 70 }]);
ok('«фигуры нет»: детектор что-то увидел — это ложная тревога', c.human && c.falseAlarm && !c.detectorFound);
c = compareWithDetector({ truth: NONE_ID }, 'double_top', []);
ok('«фигуры нет»: детектор промолчал — тревоги нет', !c.human && !c.falseAlarm);
c = compareWithDetector(rf, 'flag_bear', [{ pattern: 'pin_bar_bullish', confidence: 90 }]);
ok('свечные фигуры в сравнении не участвуют', !c.detectorSawSomething && !c.detectorFound);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки игры «Увидеть фигуру» прошли ✓');
