// src/services/report/charts.js
//
// Графики отчёта в виде SVG-строк — чистые функции без DOM, поэтому одни и те же картинки рисуются и в браузере (PDF, Word),
// и на сервере (отправка по расписанию). В PDF вставляются как векторные (pdfmake умеет SVG), в Word — через растеризацию.
// Шрифт подписей — Roboto (он же шрифт документа).

export const PALETTE = {
  ink: '#0f172a', text: '#1e293b', muted: '#64748b', faint: '#94a3b8', line: '#e2e8f0', soft: '#f1f5f9', card: '#f8fafc',
  accent: '#4f46e5', accentSoft: '#e0e7ff', green: '#059669', greenSoft: '#d1fae5', red: '#dc2626', redSoft: '#fee2e2', gold: '#d97706',
};

const FONT = 'Roboto';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (n) => (Math.round(n * 10) / 10).toString();

/** Подпись суммы на оси: 12400 → «12 тыс», 1500000 → «1,5 млн», 850 → «850». */
export function axisLabel(v) {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1).replace('.', ',')} млн`;
  if (a >= 1e4) return `${s}${Math.round(a / 1000)} тыс`;
  if (a >= 1e3) return `${s}${(a / 1000).toFixed(1).replace('.', ',').replace(/,0$/, '')} тыс`;
  return `${s}${Math.round(a)}`;
}
/** Точная сумма для подписей у столбцов: «+12 400». */
export function valueLabel(v) {
  const r = Math.round(v);
  if (r === 0) return '0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

function niceStep(range, ticks = 4) {
  const raw = range / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function niceAxis(min, max, ticks = 4) {
  min = Math.min(0, min); max = Math.max(0, max);
  if (min === max) { max = 1; }
  const step = niceStep(max - min, ticks);
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}

/**
 * Накопленный результат: линия с заливкой до нуля, сетка, подписи осей и итог на конце линии.
 * @param {{label:string, cumulative:number}[]} points
 */
export function equityCurveSvg(points, { width = 515, height = 200 } = {}) {
  const padL = 46, padR = 54, padT = 14, padB = 26;
  const w = width - padL - padR, h = height - padT - padB;
  const vals = points.map((p) => p.cumulative);
  const { lo, hi, step } = niceAxis(Math.min(0, ...vals), Math.max(0, ...vals));
  const y = (v) => padT + h - ((v - lo) / (hi - lo)) * h;
  const x = (i) => padL + (points.length <= 1 ? w / 2 : (i / (points.length - 1)) * w);
  const final = vals.length ? vals[vals.length - 1] : 0;
  const col = final >= 0 ? PALETTE.green : PALETTE.red;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  // сетка и подписи оси Y
  for (let v = lo; v <= hi + step / 2; v += step) {
    const yy = y(v);
    out.push(`<line x1="${padL}" y1="${f1(yy)}" x2="${width - padR}" y2="${f1(yy)}" stroke="${v === 0 ? PALETTE.faint : PALETTE.line}" stroke-width="${v === 0 ? 1 : 0.6}"${v === 0 ? ' stroke-dasharray="3 3"' : ''}/>`);
    out.push(`<text x="${padL - 6}" y="${f1(yy + 3)}" font-family="${FONT}" font-size="8" fill="${PALETTE.muted}" text-anchor="end">${esc(axisLabel(v))}</text>`);
  }
  if (points.length) {
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${f1(x(i))} ${f1(y(p.cumulative))}`).join(' ');
    if (points.length > 1) out.push(`<path d="${line} L${f1(x(points.length - 1))} ${f1(y(0))} L${f1(x(0))} ${f1(y(0))} Z" fill="${col}" fill-opacity="0.12"/>`);
    out.push(`<path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    const lx = x(points.length - 1), ly = y(final);
    out.push(`<circle cx="${f1(lx)}" cy="${f1(ly)}" r="3.2" fill="${col}"/>`);
    out.push(`<text x="${f1(Math.min(lx + 6, width - 2))}" y="${f1(ly + 3)}" font-family="${FONT}" font-size="9" font-weight="bold" fill="${col}">${esc(valueLabel(final))}</text>`);
    // подписи оси X: не больше 7, равномерно
    const n = points.length, maxLabels = 7, every = Math.max(1, Math.ceil(n / maxLabels));
    points.forEach((p, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every / 2) return;
      out.push(`<text x="${f1(x(i))}" y="${height - 8}" font-family="${FONT}" font-size="8" fill="${PALETTE.muted}" text-anchor="middle">${esc(p.label)}</text>`);
    });
  }
  out.push('</svg>');
  return out.join('');
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/**
 * Горизонтальные столбцы «по инструментам / стратегиям»: слева подпись, столбец от нулевой оси (вверх — зелёный, вниз — красный),
 * справа точная сумма.
 * @param {{label:string, value:number, note?:string}[]} items
 */
export function hBarsSvg(items, { width = 515, rowH = 22, labelW = 120, valueW = 78 } = {}) {
  const padT = 4, height = padT + items.length * rowH + 4;
  const x0 = labelW + 6, x1 = width - valueW;
  const vals = items.map((i) => i.value);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const zero = x0 + ((0 - lo) / span) * (x1 - x0);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  items.forEach((it, i) => {
    const yy = padT + i * rowH, cy = yy + rowH / 2;
    const bx = x0 + ((Math.min(0, it.value) - lo) / span) * (x1 - x0);
    const bw = Math.max(1.5, (Math.abs(it.value) / span) * (x1 - x0));
    const col = it.value >= 0 ? PALETTE.green : PALETTE.red;
    out.push(`<text x="0" y="${f1(cy + 3)}" font-family="${FONT}" font-size="9" fill="${PALETTE.text}">${esc(clip(it.label, 22))}</text>`);
    out.push(`<rect x="${f1(bx)}" y="${f1(yy + 4)}" width="${f1(bw)}" height="${rowH - 9}" rx="2" fill="${col}" fill-opacity="0.85"/>`);
    out.push(`<text x="${width}" y="${f1(cy + 3)}" font-family="${FONT}" font-size="9" font-weight="bold" fill="${col}" text-anchor="end">${esc(valueLabel(it.value))} ₽</text>`);
  });
  out.push(`<line x1="${f1(zero)}" y1="${padT}" x2="${f1(zero)}" y2="${height - 4}" stroke="${PALETTE.faint}" stroke-width="0.8"/>`);
  out.push('</svg>');
  return out.join('');
}

/**
 * Вертикальные столбцы (дни недели): подпись снизу, сумма над/под столбцом, число сделок мелко под подписью.
 * @param {{label:string, value:number, sub?:string}[]} items
 */
export function vBarsSvg(items, { width = 515, height = 170 } = {}) {
  const vals = items.map((i) => i.value);
  // под отрицательными столбцами нужна строка для подписи суммы, иначе она налезает на подпись дня
  const padT = 20, padB = 34 + (Math.min(0, ...vals) < 0 ? 14 : 0), padX = 10;
  const w = width - padX * 2, h = height - padT - padB;
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const y = (v) => padT + h - ((v - lo) / span) * h;
  const slot = w / items.length, bw = Math.min(46, slot * 0.56);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  out.push(`<line x1="${padX}" y1="${f1(y(0))}" x2="${width - padX}" y2="${f1(y(0))}" stroke="${PALETTE.faint}" stroke-width="0.8"/>`);
  items.forEach((it, i) => {
    const cx = padX + slot * i + slot / 2;
    const top = Math.min(y(0), y(it.value)), bh = Math.max(it.value === 0 ? 0 : 1.5, Math.abs(y(it.value) - y(0)));
    const col = it.value >= 0 ? PALETTE.green : PALETTE.red;
    if (bh > 0) out.push(`<rect x="${f1(cx - bw / 2)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(bh)}" rx="2" fill="${col}" fill-opacity="0.85"/>`);
    const ty = it.value >= 0 ? top - 4 : top + bh + 10;
    if (it.sub !== '0') out.push(`<text x="${f1(cx)}" y="${f1(ty)}" font-family="${FONT}" font-size="8.5" font-weight="bold" fill="${col}" text-anchor="middle">${esc(valueLabel(it.value))}</text>`);
    out.push(`<text x="${f1(cx)}" y="${height - 18}" font-family="${FONT}" font-size="9" font-weight="bold" fill="${PALETTE.text}" text-anchor="middle">${esc(it.label)}</text>`);
    if (it.sub != null) out.push(`<text x="${f1(cx)}" y="${height - 6}" font-family="${FONT}" font-size="7.5" fill="${PALETTE.muted}" text-anchor="middle">${esc(it.sub)}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}
