// scripts/intrabarEntryReport.mjs — сводный отчёт по сырым данным intrabarEntryStudy.mjs
// Запуск: node scripts/intrabarEntryReport.mjs
//
// Принцип отчёта: НИКАКИХ срезов по тому, что в момент сигнала неизвестно. Деление сигналов
// на «удержался до закрытия / мигнул» знает будущее (первая версия показала +1,5% против
// −1,4% — это механика остатка дня, а не свойство стратегии), поэтому здесь оно используется
// только для ОПИСАНИЯ частоты, а сравнения идут по признакам, известным в момент касания:
// стратегия и число часовых баров, оставшихся до закрытия.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HORIZONS = [1, 3, 5, 10];
const STRATEGY_NAMES = ['Фигуры+уровень', 'RSI+Боллинджер', 'EMA200+MACD'];

const files = fs.readdirSync(path.join(repoRoot, 'scripts')).filter((f) => /^_intrabar_t_.*\.json$/.test(f));
if (!files.length) { console.error('Нет файлов _intrabar_t_*.json — сначала запусти intrabarEntryStudy.mjs'); process.exit(1); }
const events = [], days = [], TICKERS = [];
const validation = { days: 0, matched: 0, unmatched: 0, noH1: 0, byWindow: {} };
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', f), 'utf8'));
  events.push(...r.events); days.push(...r.days); TICKERS.push(r.ticker);
  for (const k of ['days', 'matched', 'unmatched', 'noH1']) validation[k] += r.validation[k] || 0;
  for (const [k, v] of Object.entries(r.validation.byWindow || {})) validation.byWindow[k] = (validation.byWindow[k] || 0) + v;
}
console.log(`Файлов: ${files.length}, тикеров: ${TICKERS.length}, событий: ${events.length}, дней: ${days.length}`);
console.log(`Сверка реконструкции: свеча воспроизведена в ${(validation.matched / Math.max(1, validation.days) * 100).toFixed(0)}% дней (${validation.matched}/${validation.days}); без часовых данных ${validation.noH1}; не совпало ${validation.unmatched}`);
console.log('Какое окно подошло:', JSON.stringify(validation.byWindow));

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = (a) => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const fmt = (v, d = 2) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d));
const stat = (arr) => ({ n: arr.length, mean: avg(arr), med: med(arr), se: arr.length > 1 ? sd(arr) / Math.sqrt(arr.length) : null, win: arr.length ? arr.filter((x) => x > 0).length / arr.length * 100 : null });
const line = (name, v) => `    ${name.padEnd(46)} n=${String(v.n).padStart(5)}  среднее ${fmt(v.mean).padStart(6)} ±${v.se == null ? '—' : v.se.toFixed(2)}  медиана ${fmt(v.med).padStart(6)}  плюсовых ${v.win == null ? '—' : v.win.toFixed(0)}%`;
const g = (arr, key, h) => arr.filter((e) => e[key]?.[h] != null).map((e) => e[key][h]);

// Корзины по числу часовых баров, оставшихся до закрытия (известно в момент касания)
const bucketOf = (left) => (left >= 9 ? 'рано: осталось 9+ ч' : left >= 5 ? 'середина: осталось 5–8 ч' : left >= 2 ? 'поздно: осталось 2–4 ч' : 'перед закрытием: осталось 1 ч');
const BUCKETS = ['рано: осталось 9+ ч', 'середина: осталось 5–8 ч', 'поздно: осталось 2–4 ч', 'перед закрытием: осталось 1 ч'];

const report = { generatedAt: new Date().toISOString(), tickers: TICKERS.length, events: events.length, validation };

function block(title, list) {
  console.log(`\n=== ${title} ===`);
  const closeSig = list.filter((e) => e.inClose);
  const intraSig = list.filter((e) => e.hasIntra);
  const persisted = intraSig.filter((e) => e.persist);
  console.log(`Сигналов по закрытию (как у робота): ${closeSig.length}`);
  console.log(`Сигналов внутри дня (первое касание): ${intraSig.length}  → ×${(intraSig.length / Math.max(1, closeSig.length)).toFixed(2)} к числу сигналов по закрытию`);
  console.log(`  доля первых касаний, которые к закрытию ПРОПАЛИ: ${((1 - persisted.length / Math.max(1, intraSig.length)) * 100).toFixed(0)}%  (описание частоты; в момент касания этого не знаешь)`);
  console.log(`  сигналов, которые появились ТОЛЬКО на закрытии: ${closeSig.filter((e) => !e.hasIntra).length} (${(closeSig.filter((e) => !e.hasIntra).length / Math.max(1, closeSig.length) * 100).toFixed(0)}% сигналов робота)`);

  const out = { closeSignals: closeSig.length, intraSignals: intraSig.length, persistShare: persisted.length / Math.max(1, intraSig.length), byHorizon: {}, byBucket: {} };
  console.log('\n  Что происходит ПОСЛЕ сигнала (хвост до закрытия дня i+N, % в сторону сделки) — всё, что известно на момент решения:');
  for (const h of HORIZONS) {
    const A = stat(g(closeSig, 'close', h));
    const B = stat(g(intraSig, 'intra', h));
    out.byHorizon[h] = { closeBar: A, firstTouch: B };
    console.log(`  Через ${h} дн.:`);
    console.log(line('А. Вход по закрытию (как робот)', A));
    console.log(line('Б. Вход по первому касанию внутри дня', B));
  }

  console.log('\n  По времени первого касания (эта разбивка честная: час известен в момент сигнала):');
  for (const bname of BUCKETS) {
    const sub = intraSig.filter((e) => bucketOf(e.left) === bname);
    if (!sub.length) continue;
    const pers = sub.filter((e) => e.persist).length / sub.length * 100;
    const r5 = stat(g(sub, 'intra', 5)), r1 = stat(g(sub, 'intra', 1));
    out.byBucket[bname] = { n: sub.length, persistPct: pers, r1, r5 };
    console.log(`    ${bname.padEnd(34)} n=${String(sub.length).padStart(5)}  удержится до закрытия ${pers.toFixed(0).padStart(3)}%   через 1 дн. ${fmt(r1.mean)}%  через 5 дн. ${fmt(r5.mean)}% ±${r5.se?.toFixed(2)}`);
  }
  return out;
}

report.all = block('ВСЕ СТРАТЕГИИ', events);
for (const sName of STRATEGY_NAMES) report[sName] = block(sName, events.filter((e) => e.s === sName));

console.log('\n=== Ориентир: безусловный дрейф всех проанализированных дней (от открытия след. дня) ===');
for (const h of HORIZONS) {
  const v = days.map((d) => d.drift[h]).filter((x) => x != null);
  console.log(`  ${h} дн.: среднее ${fmt(avg(v))}% (лонг), шорт зеркально; n=${v.length}`);
}
report.drift = Object.fromEntries(HORIZONS.map((h) => [h, avg(days.map((d) => d.drift[h]).filter((x) => x != null))]));

fs.writeFileSync(path.join(repoRoot, 'scripts', '_intrabar_out.json'), JSON.stringify(report, null, 1));
console.log('\nСохранено: scripts/_intrabar_out.json');
