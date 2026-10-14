// Проверка выбора блоков технического анализа (npm run test:taview).
import {
  TA_SECTIONS, TA_IDS, DEFAULT_TA_PREFS, normalizeTaPrefs, strategyUsage, resolveTaView, chartLayersFor, countVisible,
} from '../src/services/analytics/taView.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const cond = (id, param = null, enabled = true) => ({ id, enabled, param, direction: 'both' });

ok('девять блоков, id не повторяются', TA_SECTIONS.length === 9 && new Set(TA_IDS).size === 9);
ok('по умолчанию показано всё', Object.values(DEFAULT_TA_PREFS).every((v) => v === true));

// --- настройки пользователя ---
ok('пусто → всё включено', countVisible(normalizeTaPrefs(null)) === 9 && countVisible(normalizeTaPrefs(undefined)) === 9);
ok('выключенный блок остаётся выключенным', normalizeTaPrefs({ fibonacci: false }).fibonacci === false && normalizeTaPrefs({ fibonacci: false }).rsi === true);
ok('мусорные значения игнорируются', normalizeTaPrefs({ rsi: 'нет', macd: 0, volume: null }).rsi === true && normalizeTaPrefs({ rsi: 'нет' }).macd === true);
ok('лишние ключи отбрасываются', !('zzz' in normalizeTaPrefs({ zzz: false })));

// --- режим «без стратегии» ---
let v = resolveTaView({ prefs: { fibonacci: false, patterns: false } });
ok('без стратегии: показываются включённые в настройках', v.visible.rsi && !v.visible.fibonacci && !v.visible.patterns && countVisible(v.visible) === 7);
ok('без стратегии: нет подписей порогов и флага призмы', v.lens === false && Object.keys(v.notes).length === 0);
v = resolveTaView({ prefs: Object.fromEntries(TA_IDS.map((id) => [id, false])) });
ok('всё выключено → empty', v.empty === true);

// --- режим «по стратегии» ---
const s = { conditions: [cond('rsi_below', 35), cond('near_support', 1), cond('volume_above_avg', 1.5), cond('min_rr', 2), cond('macd_positive', null, false)] };
const u = strategyUsage(s);
ok('используются RSI, уровни и объём', u.used.rsi && u.used.levels && u.used.volume);
ok('выключенное условие не считается', u.used.macd === false);
ok('условие плана не создаёт блока', countVisible(u.used) === 3);
ok('порог RSI в подписи', u.notes.rsi === 'ниже 35');
ok('порог уровня в подписи', u.notes.levels === 'у поддержки, в пределах 1%');
ok('порог объёма в подписи', u.notes.volume === 'не меньше ×1,5 от обычного');
v = resolveTaView({ prefs: { rsi: false }, strategy: s });
ok('призма сильнее личных настроек: RSI виден, хотя в настройках выключен', v.visible.rsi === true && v.lens === true);
ok('призма: Фибоначчи нет, т.к. стратегия им не пользуется', v.visible.fibonacci === false);
ok('призма: блок «контекст» скрыт', v.visible.context === false);

// две стороны одного индикатора склеиваются
const both = strategyUsage({ conditions: [cond('rsi_below', 30), cond('rsi_above', 70)] });
ok('RSI с двух сторон: обе подписи', both.notes.rsi === 'ниже 30 · выше 70');
const ema = strategyUsage({ conditions: [cond('price_above_ema200')] });
ok('EMA200 включает блок EMA', ema.used.ema === true && ema.notes.ema === 'цена выше EMA200');
const ctx = strategyUsage({ conditions: [cond('market_trending'), cond('volatility_not_high')] });
ok('тренд и волатильность — один блок «контекст»', ctx.used.context === true && ctx.notes.context.includes('в тренде') && ctx.notes.context.includes('не повышена'));
const boll = strategyUsage({ conditions: [cond('bollinger_lower', 0.1)] });
ok('Боллинджер', boll.used.bollinger === true);
const pat = strategyUsage({ conditions: [cond('pattern_confirmed', 70)] });
ok('фигуры с порогом уверенности', pat.used.patterns === true && pat.notes.patterns === 'уверенность не ниже 70%');

// стратегия без рыночных условий
const planOnly = resolveTaView({ strategy: { conditions: [cond('min_rr', 2), cond('max_risk_percent', 1)] } });
ok('только условия плана → призма пустая', planOnly.empty === true && planOnly.lens === true);
ok('стратегия без условий → пусто', resolveTaView({ strategy: { conditions: [] } }).empty === true);
ok('null-стратегия — не призма', resolveTaView({ strategy: null }).lens === false);

// --- слои графика ---
const layers = chartLayersFor({ rsi: true, levels: true, ema: true, fibonacci: false });
ok('слои: RSI, S/R и три EMA', ['rsi', 'sr', 'ema9', 'ema100', 'ema200'].every((l) => layers.includes(l)) && layers.length === 5);
ok('слои: Фибоначчи не включается', !layers.includes('fibonacci'));
ok('слои: пусто → пусто', chartLayersFor({}).length === 0 && chartLayersFor(null).length === 0);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки технического анализа прошли ✓');
