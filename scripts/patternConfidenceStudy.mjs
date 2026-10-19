// Влияет ли «процент уверенности» фигуры на то, что цена пойдёт в ожидаемую сторону?
// Запуск: node scripts/patternConfidenceStudy.mjs [число тикеров]  → scripts/PATTERN_CONFIDENCE_REPORT.md
//
// Данные: кэш дневных свечей scripts/_d1_candles_long.json (сеть не нужна).
// Для каждого бара (шаг 3) считаем фигуры так, как их видит приложение (computePatternsAtEntry, только данные
// ДО этого бара). Одна и та же фигура на соседних барах считается один раз (тип + первая точка).
// Исход — по направлению фигуры (бычья/медвежья из каталога приложения): доходность за 10 баров от открытия
// следующего бара, в ATR, со знаком «в сторону фигуры»; «попала» = результат > 0.
// Контроль: та же доля «попаданий» у ВСЕХ баров без фигур (дрейф рынка) — иначе красивая цифра может быть
// просто ростом рынка. Проверка устойчивости: история делится пополам по времени.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-pcs-'));
function esmify(p_) {
  let t = fs.readFileSync(p_, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  fs.writeFileSync(path.join(tmpDir, path.basename(p_)), t, 'utf8');
}
for (const f of ['indicators', 'candlestickPatterns', 'patterns']) esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
const { computePatternsAtEntry, PATTERN_DIRECTIONS, PATTERN_LABELS } = await import(pathToFileURL(path.join(tmpDir, 'patterns.js')).href);

const NT = Number(process.argv[2]) || 40;
const STRIDE = 3, HORIZON = 10, START_BACK = 1800;
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '_d1_candles_long.json'), 'utf8'));
const tickers = Object.keys(raw).slice(0, NT);

function atrSeries(c, n = 14) {
  const out = new Array(c.length).fill(null); let prev = null; const buf = [];
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (prev == null) { buf.push(tr); if (buf.length === n) { prev = buf.reduce((s, v) => s + v, 0) / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + tr) / n; out[i] = prev; }
  }
  return out;
}
const dirOf = (p) => (PATTERN_DIRECTIONS.bullish.includes(p) ? 1 : PATTERN_DIRECTIONS.bearish.includes(p) ? -1 : 0);

const rows = []; const baseline = { up: [0, 0], down: [0, 0] };
for (const t of tickers) {
  const candles = raw[t].map(([d, o, h, l, c, v]) => ({ date: new Date(d), open: o, high: h, low: l, close: c, volume: v }));
  if (candles.length < 500) continue;
  const atr = atrSeries(candles);
  const seen = new Set();
  const from = Math.max(250, candles.length - START_BACK);
  process.stdout.write(`${t} `);
  for (let i = from; i < candles.length - HORIZON - 2; i += STRIDE) {
    if (!atr[i]) continue;
    const ref = candles[i + 1].open, end = candles[i + 1 + HORIZON - 1].close;
    const retAtr = (end - ref) / atr[i];
    baseline.up[1]++; if (retAtr > 0) baseline.up[0]++;
    baseline.down[1]++; if (retAtr < 0) baseline.down[0]++;
    let pats; try { pats = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: 1440 }); } catch { continue; }
    for (const c of (pats?.candidates ?? [])) {
      const d = dirOf(c.pattern); if (!d) continue;
      const anchor = c.points?.length ? `p${c.points[0].index}` : c.level != null ? `l${Number(c.level).toFixed(3)}` : `b${i}`;
      const id = `${t}|${c.pattern}|${c.status}|${anchor}`;
      if (seen.has(id)) continue; seen.add(id);
      rows.push({ t, pattern: c.pattern, status: c.status, conf: c.confidence, d, i, date: candles[i].date, signed: retAtr * d });
    }
  }
}
console.log(`\nСлучаев: ${rows.length}`);

const hit = (a) => a.length ? a.filter((r) => r.signed > 0).length / a.length : null;
const avg = (a) => (a.length ? a.reduce((s, r) => s + r.signed, 0) / a.length : null);
const pc = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const f2 = (v) => (v == null ? '—' : v.toFixed(2));
const ci = (p, n) => (n ? `±${(196 * Math.sqrt(p * (1 - p) / n)).toFixed(0)}` : '');
function spearman(x, y) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const rk = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = rk; i = j + 1; } return r; };
  const rx = rank(x), ry = rank(y), n = x.length; const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
const times = rows.map((r) => r.date.getTime()).sort((a, b) => a - b); const mid = times[Math.floor(times.length / 2)];
const buckets = [['до 60', 0, 60], ['60–69', 60, 70], ['70–79', 70, 80], ['80 и выше', 80, 1000]];
const bUp = baseline.up[0] / baseline.up[1], bDown = baseline.down[0] / baseline.down[1];

let md = `# Влияет ли процент уверенности фигуры на исход\n\nДата: ${new Date().toISOString().slice(0, 10)}. Тикеров: ${tickers.length}, дневные свечи, последние ~${START_BACK} баров, шаг ${STRIDE}. Случаев (уникальных фигур с направлением): ${rows.length}.\n\n`;
md += `Исход: доходность за ${HORIZON} баров от открытия следующего бара, в ATR, со знаком «в сторону фигуры». «Попала» — результат > 0.\n`;
md += `Контроль — доля «попаданий» у ВСЕХ баров без разбора фигур: бычье направление **${pc(bUp)}**, медвежье **${pc(bDown)}** (это дрейф рынка: выше этого уровня фигура должна давать перевес, иначе она ничего не добавляет).\n\n`;

function table(title, subset) {
  let s = `### ${title}\n\n| Уверенность | Случаев | Попала | ± (95%) | Средний ход, ATR | первая половина | вторая половина |\n|---|---|---|---|---|---|---|\n`;
  for (const [name, lo, hi] of buckets) {
    const a = subset.filter((r) => r.conf >= lo && r.conf < hi);
    const h1 = a.filter((r) => r.date.getTime() < mid), h2 = a.filter((r) => r.date.getTime() >= mid);
    s += `| ${name} | ${a.length} | ${pc(hit(a))} | ${a.length ? ci(hit(a), a.length) : ''} | ${f2(avg(a))} | ${pc(hit(h1))} (n=${h1.length}) | ${pc(hit(h2))} (n=${h2.length}) |\n`;
  }
  const rho = subset.length > 30 ? spearman(subset.map((r) => r.conf), subset.map((r) => r.signed)) : null;
  s += `\nСвязь «уверенность → ход» (Спирмен): **${f2(rho)}** на ${subset.length} случаях (0 = нет связи; |ρ| < 0,05 — практически ноль).\n\n`;
  return s;
}
md += table('Все фигуры вместе', rows);
md += table('Только подтверждённые (confirmed)', rows.filter((r) => r.status === 'confirmed'));
md += table('Только формирующиеся (forming)', rows.filter((r) => r.status === 'forming'));
md += table('Только бычьи', rows.filter((r) => r.d === 1));
md += table('Только медвежьи', rows.filter((r) => r.d === -1));

md += `## По типам фигур\n\n| Фигура | Направление | Случаев | Попала | Контроль (рынок) | Перевес | Средний ход, ATR | ρ(уверенность→ход) |\n|---|---|---|---|---|---|---|---|\n`;
const types = [...new Set(rows.map((r) => r.pattern))];
const lines = types.map((p) => {
  const a = rows.filter((r) => r.pattern === p); const d = a[0].d; const base = d === 1 ? bUp : bDown;
  const rho = a.length >= 30 ? spearman(a.map((r) => r.conf), a.map((r) => r.signed)) : null;
  return { p, d, n: a.length, h: hit(a), base, edge: hit(a) != null ? hit(a) - base : null, av: avg(a), rho };
}).sort((x, y) => y.n - x.n);
for (const l of lines) {
  md += `| ${PATTERN_LABELS[l.p] || l.p} | ${l.d === 1 ? 'вверх' : 'вниз'} | ${l.n} | ${l.n < 30 ? 'мало' : pc(l.h)} | ${pc(l.base)} | ${l.n < 30 ? '—' : `${l.edge >= 0 ? '+' : ''}${(l.edge * 100).toFixed(1)} п.п.`} | ${l.n < 30 ? '—' : f2(l.av)} | ${f2(l.rho)} |\n`;
}
md += `\nМенее 30 случаев — вывода не делаем. Перевес считается относительно дрейфа рынка того же направления.\n`;
fs.writeFileSync(path.join(__dirname, 'PATTERN_CONFIDENCE_REPORT.md'), md, 'utf8');
console.log(md);
