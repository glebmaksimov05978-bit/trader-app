// src/services/trainer/patternQuiz.js
//
// Игра «Увидеть фигуру» тренажёра «Тренд»: показываем график с вложенной фигурой (или без неё), игрок называет
// фигуру, затем видит продолжение и ответ. Чистый модуль без зависимостей от React/Firebase — тестируется в node
// (scripts/patternQuizTests.mjs). Прогресс игрока — обычный объект, который страница кладёт в профиль.
//
// Честность: продолжение после фигуры в игре нарисовано по логике фигуры (учебная модель). На реальном рынке фигуры
// не гарантируют продолжения — об этом сказано в карточках теории и в самом разборе раунда. Вариант «фигуры нет»
// есть с 3-го уровня намеренно: учит не видеть фигуры там, где их нет (детекторы приложения «видят» что-нибудь на ~90 %
// случайных графиков, см. npm run eval:patterns).
import { generatePattern, makeRng, PATTERN_SPECS } from './patternGenerator.js';

export const NONE_ID = 'none';

// Какие названия детекторов приложения считать «верным ответом» для каждой фигуры (флаги у детектора названы по
// наклону канала). Общая таблица для замера (scripts/patternGeneratorEval.mjs) и для сравнения «человек против алгоритма».
export const DETECTOR_ACCEPT = {
  double_top: ['double_top'], double_bottom: ['double_bottom'],
  head_shoulders_top: ['head_shoulders_top'], head_shoulders_bottom: ['head_shoulders_bottom'],
  triangle_ascending: ['triangle_ascending'], triangle_descending: ['triangle_descending'],
  triangle_symmetric: ['triangle_symmetric', 'pennant_bullish', 'pennant_bearish'],
  wedge_rising: ['wedge_rising'], wedge_falling: ['wedge_falling'],
  flag_bull: ['flag_descending', 'flag_horizontal', 'pennant_bullish'],
  flag_bear: ['flag_ascending', 'flag_horizontal', 'pennant_bearish'],
};

export const THEORY = {
  double_top: {
    name: 'Двойная вершина',
    look: 'Цена дважды доходит почти до одного и того же уровня сверху и откатывается; между вершинами — заметная впадина.',
    logic: 'Покупатели дважды не смогли пробить «потолок». Классический сигнал — пробой уровня впадины вниз.',
    trap: 'Две похожие вершины встречаются в обычном шуме постоянно. Без заметной впадины и пробоя её уровня это просто совпадение.',
  },
  double_bottom: {
    name: 'Двойное дно',
    look: 'Цена дважды падает почти до одного и того же уровня и отскакивает; между доньями — заметная вершина.',
    logic: 'Продавцы дважды не смогли продавить «пол». Классический сигнал — пробой уровня вершины между доньями вверх.',
    trap: 'Как и с двойной вершиной: два похожих минимума в шуме — не фигура. Ждите пробоя, а не рисуйте фигуру по двум точкам.',
  },
  head_shoulders_top: {
    name: 'Голова и плечи',
    look: 'Три вершины: средняя (голова) выше двух боковых (плечи). Впадины между ними лежат примерно на одном уровне — это «линия шеи».',
    logic: 'Рост выдыхается: голова не удержана, правое плечо ниже головы. Сигнал — пробой линии шеи вниз.',
    trap: 'Самая «красивая» и самая редкая фигура: на живом графике её часто дорисовывают глазом. Проверьте, что плечи примерно равны, а шея ровная.',
  },
  head_shoulders_bottom: {
    name: 'Перевёрнутые голова и плечи',
    look: 'Три впадины: средняя (голова) глубже двух боковых (плечи). Вершины между ними — линия шеи.',
    logic: 'Падение выдыхается. Сигнал — пробой линии шеи вверх.',
    trap: 'Та же ловушка, что и у «Головы и плеч»: легко дорисовать глазом. Сигналом служит только пробой шеи.',
  },
  triangle_ascending: {
    name: 'Восходящий треугольник',
    look: 'Верхняя граница горизонтальна (цена упирается в один уровень), нижняя поднимается — минимумы всё выше.',
    logic: 'Покупатели давят всё сильнее. Чаще всего ждут пробоя горизонтального уровня вверх.',
    trap: 'Пробой может быть ложным: цена выходит за уровень и возвращается. Смотрите на закрепление выше уровня.',
  },
  triangle_descending: {
    name: 'Нисходящий треугольник',
    look: 'Нижняя граница горизонтальна (цена опирается на один уровень), верхняя опускается — максимумы всё ниже.',
    logic: 'Продавцы давят всё сильнее. Чаще всего ждут пробоя горизонтального уровня вниз.',
    trap: 'Ложный пробой вниз с быстрым возвратом — частая история; не входите на первой же свече за уровнем без плана.',
  },
  triangle_symmetric: {
    name: 'Симметричный треугольник',
    look: 'Обе границы сходятся: максимумы ниже, минимумы выше. Колебания затухают.',
    logic: 'Сжатие перед движением. Направление заранее неизвестно — это фигура продолжения тренда или разворота.',
    trap: 'Направление выхода не предсказать: решает пробой. Входить «заранее» значит гадать.',
  },
  wedge_rising: {
    name: 'Восходящий клин',
    look: 'Обе границы идут вверх и сходятся: цена растёт, но всё слабее (диапазон сужается).',
    logic: 'Рост теряет силу. Чаще ждут пробоя вниз.',
    trap: 'Самая плохо различимая фигура: клин легко спутать с треугольником и флагом. Ориентир — обе линии наклонены вверх.',
  },
  wedge_falling: {
    name: 'Нисходящий клин',
    look: 'Обе границы идут вниз и сходятся: цена падает, но всё слабее.',
    logic: 'Падение теряет силу. Чаще ждут пробоя вверх.',
    trap: 'Как у восходящего клина: ориентир — обе линии наклонены вниз и сходятся; без этого это просто нисходящий канал.',
  },
  flag_bull: {
    name: 'Флаг после роста',
    look: 'Резкий рывок вверх («древко»), затем небольшой наклонный канал вниз или вбок («полотнище»).',
    logic: 'Пауза после импульса. Часто ждут продолжения роста после выхода из канала вверх.',
    trap: 'Без сильного рывка перед каналом это не флаг. И продолжение в игре нарисовано по логике фигуры — на рынке оно не гарантировано.',
  },
  flag_bear: {
    name: 'Флаг после падения',
    look: 'Резкое падение («древко»), затем небольшой наклонный канал вверх или вбок.',
    logic: 'Пауза после импульса. Часто ждут продолжения падения после выхода из канала вниз.',
    trap: 'Тот же признак: без резкого падения перед каналом это не флаг.',
  },
  none: {
    name: 'Фигуры нет',
    look: 'Обычное блуждание цены: нет ни ровных границ, ни повторяющихся точек разворота, ни рывка с последующей паузой.',
    logic: 'Не каждый график — «фигура». Умение сказать «здесь ничего нет» — навык, а не слабость.',
    trap: 'Глаз склонен находить узоры в шуме. Если приходится «подгонять» линии — скорее всего, фигуры нет.',
  },
};

export const PATTERN_NAMES = Object.fromEntries(Object.entries(THEORY).map(([k, v]) => [k, v.name]));

export const LEVELS = [
  { id: 1, name: 'Основы', xpFrom: 0, noise: 0.3, options: 3, withNone: false,
    patterns: ['flag_bull', 'flag_bear', 'triangle_ascending', 'triangle_descending'] },
  { id: 2, name: 'Развороты', xpFrom: 100, noise: 0.4, options: 4, withNone: false,
    patterns: ['double_top', 'double_bottom', 'head_shoulders_top', 'head_shoulders_bottom', 'triangle_ascending', 'triangle_descending'] },
  { id: 3, name: 'Сужения и «пусто»', xpFrom: 300, noise: 0.5, options: 5, withNone: true,
    patterns: ['triangle_symmetric', 'wedge_rising', 'wedge_falling', 'flag_bull', 'flag_bear', 'double_top', 'double_bottom'] },
  { id: 4, name: 'Шум', xpFrom: 600, noise: 0.7, options: 6, withNone: true,
    patterns: Object.keys(PATTERN_SPECS) },
];

export function levelForXp(xp) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if ((xp || 0) >= l.xpFrom) cur = l;
  return cur;
}
export function nextLevel(xp) {
  return LEVELS.find((l) => l.xpFrom > (xp || 0)) || null;
}

// ---------- раунд ----------
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Один раунд: график, правильный ответ и варианты ответа. Один и тот же (уровень, семя) — всегда один и тот же раунд. */
export function buildRound({ levelId = 1, seed = 1 } = {}) {
  const level = LEVELS.find((l) => l.id === levelId) || LEVELS[0];
  const rng = makeRng((seed * 7919 + level.id * 104729) >>> 0);
  const wantNone = level.withNone && rng() < 0.18;
  const truth = wantNone ? NONE_ID : level.patterns[Math.floor(rng() * level.patterns.length)];
  const pool = level.patterns.filter((p) => p !== truth);
  const distractors = shuffled(pool, rng).slice(0, Math.max(1, level.options - 1 - (level.withNone && truth !== NONE_ID ? 1 : 0)));
  let options = [truth, ...distractors];
  if (level.withNone && !options.includes(NONE_ID)) options.push(NONE_ID);
  options = shuffled(options, rng);
  const g = generatePattern(truth, { seed, noise: level.noise });
  return { seed, levelId: level.id, truth, options, candles: g.candles, cut: g.cut, direction: g.truth.direction, noise: level.noise };
}

/** Видимая часть графика до ответа и скрытое продолжение. */
export function splitRound(round) {
  return { visible: round.candles.slice(0, round.cut + 1), hidden: round.candles.slice(round.cut + 1) };
}

// ---------- прогресс ----------
export function emptyProgress() {
  return { xp: 0, answered: 0, correct: 0, streak: 0, bestStreak: 0, byPattern: {}, confusions: {}, updatedAt: null };
}

export const XP_CORRECT = 10;
export const XP_STREAK_BONUS = 2; // за каждый верный ответ подряд, начиная с третьего
export const XP_STREAK_CAP = 10;

export function gradeAnswer(round, answerId) {
  return { correct: answerId === round.truth, truth: round.truth, answer: answerId };
}

/** Новый прогресс после ответа (исходный объект не меняется). */
export function applyAnswer(progress, round, answerId) {
  const p = JSON.parse(JSON.stringify(progress || emptyProgress()));
  const g = gradeAnswer(round, answerId);
  p.answered += 1;
  const slot = p.byPattern[round.truth] || { n: 0, ok: 0 };
  slot.n += 1;
  let gained = 0;
  if (g.correct) {
    slot.ok += 1;
    p.correct += 1;
    p.streak += 1;
    p.bestStreak = Math.max(p.bestStreak, p.streak);
    gained = XP_CORRECT + (p.streak >= 3 ? Math.min(XP_STREAK_CAP, (p.streak - 2) * XP_STREAK_BONUS) : 0);
    p.xp += gained;
  } else {
    p.streak = 0;
    const key = `${round.truth}>${answerId}`;
    p.confusions[key] = (p.confusions[key] || 0) + 1;
  }
  p.byPattern[round.truth] = slot;
  p.updatedAt = new Date().toISOString();
  return { progress: p, correct: g.correct, gained };
}

/** Сводка для экрана: точность, слабые фигуры (не меньше 5 раундов), самая частая путаница. */
export function progressSummary(progress) {
  const p = progress || emptyProgress();
  const accuracy = p.answered ? p.correct / p.answered : null;
  const weak = Object.entries(p.byPattern)
    .filter(([, v]) => v.n >= 5)
    .map(([id, v]) => ({ id, n: v.n, accuracy: v.ok / v.n }))
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 3);
  const conf = Object.entries(p.confusions).sort((a, b) => b[1] - a[1])[0] || null;
  const topConfusion = conf && conf[1] >= 3 ? { truth: conf[0].split('>')[0], answer: conf[0].split('>')[1], n: conf[1] } : null;
  return { accuracy, weak, topConfusion, level: levelForXp(p.xp), next: nextLevel(p.xp) };
}

/**
 * Сравнение «человек против алгоритма» по одному раунду. `candidates` — список кандидатов детектора на
 * видимой части графика (как возвращает computePatternsAtEntry: [{pattern, confidence}]).
 */
export function compareWithDetector(round, answerId, candidates) {
  const list = (candidates || []).filter((c) => !/^(pin_bar|engulfing)/.test(c.pattern));
  const top = list.length ? list.slice().sort((a, b) => b.confidence - a.confidence)[0] : null;
  const accepted = round.truth === NONE_ID ? [] : (DETECTOR_ACCEPT[round.truth] || []);
  const detectorFound = list.some((c) => accepted.includes(c.pattern));
  const detectorTopRight = !!top && accepted.includes(top.pattern);
  const detectorSawSomething = list.length > 0;
  return {
    human: answerId === round.truth,
    detectorFound,            // нужная фигура есть среди кандидатов
    detectorTopRight,         // нужная фигура — главный кандидат
    detectorSawSomething,     // детектор что-то «увидел» (для раунда «фигуры нет» это ложное срабатывание)
    detectorTop: top ? { pattern: top.pattern, confidence: top.confidence } : null,
    falseAlarm: round.truth === NONE_ID && detectorSawSomething,
  };
}
