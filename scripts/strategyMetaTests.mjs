// Проверка «паспорта» стратегии: горизонт, таймфрейм, сопровождение, наблюдение (npm run test:stratmeta).
import {
  HORIZONS, suggestedTimeframes, followWarnings, validateFollow, captionOf, followStrategy, unfollowStrategy,
  setObserve, followedStrategies, hasFollowFlags, paperStrategyIdsFor, timeframeFor, sameClass, classKey,
  workTimeframeOf, tfLabel,
} from '../src/services/analytics/strategyMeta.js';
import { paperTelegramAllowed } from '../src/services/alerts.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const S = (id, extra = {}) => ({ id, name: `С-${id}`, conditions: [], ...extra });

// --- горизонты и таймфреймы ---
ok('три горизонта', HORIZONS.map((h) => h.id).join() === 'short,medium,long');
ok('краткосрок предлагает М15 и Ч1', suggestedTimeframes('short').join() === 'M15,H1');
ok('долгосрок предлагает только Д1', suggestedTimeframes('long').join() === 'D1');
ok('неизвестный горизонт — пусто', suggestedTimeframes('x').length === 0);
ok('подписи таймфреймов', tfLabel('H1') === 'Ч1' && tfLabel('D1') === 'Д1' && tfLabel('M15') === 'М15');

// --- проверка формы ---
ok('без горизонта — нельзя', !validateFollow({ horizon: null, timeframe: 'H1' }).ok);
ok('без таймфрейма — нельзя', !validateFollow({ horizon: 'short', timeframe: null }).ok);
ok('чужой таймфрейм — нельзя', !validateFollow({ horizon: 'short', timeframe: 'W1' }).ok);
ok('краткосрок + Ч1 — можно', validateFollow({ horizon: 'short', timeframe: 'H1' }).ok);

// --- предупреждения ---
ok('Д1 для краткосрока — предупреждение о нетипичном', followWarnings({ horizon: 'short', timeframe: 'D1' }).some((w) => /нетипичен/.test(w)));
ok('краткосрок + Ч1 — без предупреждений', followWarnings({ horizon: 'short', timeframe: 'H1' }).length === 0);
ok('М5 — предупреждение про проверку раз в 15 минут', followWarnings({ horizon: 'short', timeframe: 'M5' }).some((w) => /15 минут/.test(w)));
ok('М15 тоже меньше часа — предупреждение', followWarnings({ horizon: 'short', timeframe: 'M15' }).length === 1);

// --- постановка на сопровождение ---
const base = S('a');
const f = followStrategy(base, { horizon: 'short', timeframe: 'H1' });
ok('followStrategy ставит поля', f.followed === true && f.horizon === 'short' && f.timeframe === 'H1' && f.observe === false);
ok('исходный объект не изменён', base.followed === undefined && base.horizon === undefined);
ok('followStrategy сохраняет остальные поля', f.id === 'a' && f.name === 'С-a');
ok('followStrategy без горизонта бросает', throws(() => followStrategy(base, { timeframe: 'H1' })));
ok('followStrategy с наблюдением', followStrategy(base, { horizon: 'long', timeframe: 'D1', observe: true }).observe === true);
const u = unfollowStrategy(f);
ok('снятие: followed=false, observe=false, горизонт сохранён', u.followed === false && u.observe === false && u.horizon === 'short' && u.timeframe === 'H1');
ok('наблюдение включается и выключается', setObserve(f, true).observe === true && setObserve(setObserve(f, true), false).observe === false);
ok('подпись плашки', captionOf(f) === 'краткосрок · Ч1');
ok('подпись без данных пустая', captionOf(base) === '');
ok('рабочий таймфрейм: мусор → null', workTimeframeOf({ timeframe: 'W9' }) === null && workTimeframeOf(f) === 'H1');

// --- что показывает Сопровождение ---
const list = [S('a'), S('b', { followed: true, horizon: 'medium', timeframe: 'D1' }), S('c')];
ok('есть отмеченные — показываем только их', followedStrategies(list).map((s) => s.id).join() === 'b');
ok('нет отмеченных (старый аккаунт) — показываем все', followedStrategies([S('a'), S('c')]).length === 2);
ok('hasFollowFlags', hasFollowFlags(list) === true && hasFollowFlags([S('a')]) === false);
ok('не массив не падает', followedStrategies(null).length === 0 && hasFollowFlags(undefined) === false);

// --- какие стратегии торгуют бумажно ---
const prof = { strategies: list, alertPrefs: { paperStrategyIds: ['c', 'zzz'] } };
ok('явный список + сопровождаемые, без дублей и без удалённых', paperStrategyIdsFor(prof).join() === 'c,b');
ok('явный список пуст, сопровождаемых нет → пусто (прежнее поведение робота)', paperStrategyIdsFor({ strategies: [S('a')], alertPrefs: {} }).length === 0);
ok('только сопровождаемые', paperStrategyIdsFor({ strategies: list }).join() === 'b');
ok('стратегия в обоих списках не дублируется', paperStrategyIdsFor({ strategies: list, alertPrefs: { paperStrategyIds: ['b'] } }).join() === 'b');
ok('пустой профиль не падает', paperStrategyIdsFor(null).length === 0);

// --- таймфрейм, на котором стратегия смотрит запись радара ---
ok('свой рабочий важнее записи радара', timeframeFor(f, { timeframe: 'D1' }, { preferredTimeframe: 'M15' }) === 'H1');
ok('нет своего — берём запись радара', timeframeFor(base, { timeframe: 'M15' }, { preferredTimeframe: 'D1' }) === 'M15');
ok('нет и её — настройки профиля', timeframeFor(base, {}, { preferredTimeframe: 'H1' }) === 'H1');
ok('ничего нет — запасной', timeframeFor(base, {}, {}, 'D1') === 'D1');

// --- «одного класса» ---
const a = followStrategy(S('a'), { horizon: 'short', timeframe: 'H1' });
const b = followStrategy(S('b'), { horizon: 'short', timeframe: 'H1' });
const c = followStrategy(S('c'), { horizon: 'short', timeframe: 'M15' });
const d = followStrategy(S('d'), { horizon: 'long', timeframe: 'H1' });
ok('одинаковые горизонт и таймфрейм — один класс', sameClass(a, b) && classKey(a) === classKey(b));
ok('другой таймфрейм — другой класс', !sameClass(a, c) && classKey(a) !== classKey(c));
ok('другой горизонт — другой класс', !sameClass(a, d));
ok('без паспорта — класса нет, сравнивать не с кем', classKey(S('x')) === null && !sameClass(S('x'), S('y')));

// --- уведомления: режим наблюдения ---
ok('обычная стратегия — уведомления идут', paperTelegramAllowed({}, 'a', [S('a')]) === true);
ok('наблюдение глушит уведомления', paperTelegramAllowed({}, 'a', [S('a', { observe: true })]) === false);
ok('наблюдение другой стратегии не мешает', paperTelegramAllowed({}, 'a', [S('a'), S('b', { observe: true })]) === true);
ok('старый вызов без списка стратегий работает как раньше', paperTelegramAllowed({}, 'a') === true && paperTelegramAllowed({ paperTelegramMuted: ['a'] }, 'a') === false);
ok('общий выключатель сильнее', paperTelegramAllowed({ paperTelegram: false }, 'a', [S('a')]) === false);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки паспорта стратегии прошли ✓');
