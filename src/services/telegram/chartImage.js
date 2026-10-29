// src/services/telegram/chartImage.js
//
// Картинка графика для сообщения о входе в Telegram: две панели друг под другом —
// таймфрейм, на котором работает стратегия, и следующий за ним (чтобы виден был и момент
// входа, и контекст). На каждой — последние ~30 свечей и линии входа, стопа и цели.
//
// Модуль чистый: на входе свечи и цены, на выходе строка SVG. В PNG её превращает робот
// (scripts/telegram/signalPhoto.mjs) — рисуем сами, никаких внешних сервисов, данные
// никуда не уходят.

/** Следующий (старший) таймфрейм; для дневного — недельный (собирается из дневных свечей). */
export const NEXT_TIMEFRAME = { M5: 'M15', M10: 'H1', M15: 'H1', H1: 'D1', D1: 'W1' };
export const TF_LABELS = { M5: 'М5', M10: 'М10', M15: 'М15', H1: 'Ч1', D1: 'Д1', W1: 'Н1' };

export const nextTimeframe = (tf) => NEXT_TIMEFRAME[tf] || 'D1';

/** Начало недели (понедельник, UTC) для даты. */
function weekStart(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // понедельник = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400000;
}

/** Дневные свечи → недельные (открытие первой, закрытие последней, экстремумы за неделю). */
export function aggregateWeekly(candles) {
  const out = [];
  let cur = null;
  for (const c of candles || []) {
    const t = new Date(c.date).getTime();
    const ws = weekStart(t);
    if (!cur || cur.ws !== ws) {
      cur = { ws, date: new Date(ws), open: c.open, high: c.high, low: c.low, close: c.close };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  return out.map(({ ws, ...rest }) => rest);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function priceText(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return '';
  const d = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 10 ? 2 : Math.abs(n) >= 1 ? 3 : 4;
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: d });
}

const COLORS = {
  bg: '#ffffff', grid: '#e8ebf1', text: '#3d4452', muted: '#8a92a3',
  up: '#2e9e6b', down: '#d5534f', entry: '#4a5fd6', stop: '#d5534f', take: '#2e9e6b',
};

function dateLabel(d, tf) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  if (tf === 'D1' || tf === 'W1') return `${p(x.getUTCDate())}.${p(x.getUTCMonth() + 1)}`;
  const msk = new Date(x.getTime() + 3 * 3600000);
  return `${p(msk.getUTCDate())}.${p(msk.getUTCMonth() + 1)} ${p(msk.getUTCHours())}:${p(msk.getUTCMinutes())}`;
}

/**
 * Одна панель графика.
 * @returns {string} SVG-фрагмент (<g>) высотой height, сдвинутый на offsetY
 */
function panel({ candles, tf, trade, ticker, width, height, offsetY, count, signalIndex }) {
  const padL = 14, padR = 96, padT = 48, padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const shown = candles.slice(-count);
  if (!shown.length) return '';

  // Диапазон цен: свечи + уровни. Далёкий уровень (стоп/цель в разы дальше свечей) не растягивает
  // шкалу — иначе свечи превратились бы в тонкую полоску; такой уровень рисуется у края со стрелкой.
  let lo = Math.min(...shown.map((c) => c.low));
  let hi = Math.max(...shown.map((c) => c.high));
  const span = Math.max(hi - lo, Math.abs(hi) * 0.002);
  const levels = [];
  const add = (key, price, label, color, dash) => {
    if (price == null || !Number.isFinite(Number(price))) return;
    levels.push({ key, price: Number(price), label, color, dash });
  };
  add('take', trade.takeProfit, 'Цель', COLORS.take, '6 4');
  add('entry', trade.entryPrice, 'Вход', COLORS.entry, null);
  add('stop', trade.stopLoss, 'Стоп', COLORS.stop, '6 4');
  for (const l of levels) {
    if (Math.abs(l.price - (lo + hi) / 2) <= span * 1.8) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); }
  }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
  const clampY = (p) => Math.min(padT + plotH, Math.max(padT, y(p)));

  const step = plotW / shown.length;
  const bodyW = Math.max(2, step * 0.62);
  const x = (i) => padL + step * i + step / 2;

  const parts = [];
  // сетка и подписи цен справа (подпись не рисуем там, где стоит плашка уровня)
  const levelYs = levels.map((l) => (l.price > lo && l.price < hi ? y(l.price) : null)).filter((v) => v != null);
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4;
    const yy = y(p);
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    if (levelYs.some((ly) => Math.abs(ly - yy) < 14)) continue;
    parts.push(`<text x="${width - padR + 8}" y="${(yy + 4).toFixed(1)}" font-size="12" fill="${COLORS.muted}">${esc(priceText(p))}</text>`);
  }
  // сигнальная свеча — лёгкая подсветка столбца
  if (signalIndex != null && signalIndex >= 0 && signalIndex < shown.length) {
    parts.push(`<rect x="${(x(signalIndex) - step / 2).toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${plotH}" fill="#4a5fd6" opacity="0.08"/>`);
  }
  // свечи
  shown.forEach((c, i) => {
    const up = c.close >= c.open;
    const col = up ? COLORS.up : COLORS.down;
    const xx = x(i);
    const top = y(Math.max(c.open, c.close));
    const bot = y(Math.min(c.open, c.close));
    parts.push(`<line x1="${xx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${xx.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}" stroke-width="1.4"/>`);
    parts.push(`<rect x="${(xx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1.4, bot - top).toFixed(1)}" fill="${col}"/>`);
  });
  // уровни
  for (const l of levels) {
    const inside = l.price > lo && l.price < hi;
    const yy = inside ? y(l.price) : clampY(l.price);
    const arrow = inside ? '' : (l.price > hi ? ' ↑' : ' ↓');
    const da = l.dash ? ` stroke-dasharray="${l.dash}"` : '';
    // Далёкий уровень: линию не рисуем (она слилась бы с краем), остаётся плашка со стрелкой —
    // «цель ещё выше», «стоп ещё ниже».
    if (inside) {
      parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${l.color}" stroke-width="1.6"${da}/>`);
      parts.push(`<text x="${padL + 4}" y="${(yy - 5).toFixed(1)}" font-size="11" font-weight="700" fill="${l.color}">${esc(l.label)}</text>`);
    }
    parts.push(`<rect x="${width - padR + 2}" y="${(yy - 10).toFixed(1)}" width="${padR - 6}" height="20" rx="4" fill="${l.color}"${inside ? '' : ' opacity="0.85"'}/>`);
    parts.push(`<text x="${width - padR + 8}" y="${(yy + 4).toFixed(1)}" font-size="12" font-weight="700" fill="#ffffff">${esc(priceText(l.price))}${arrow}</text>`);
  }
  // метка входа: треугольник на последней свече (вход — по открытию этой свечи)
  const lastX = x(shown.length - 1);
  const ey = y(trade.entryPrice);
  const long = trade.direction !== 'short';
  const tri = long
    ? `${lastX},${ey - 2} ${lastX - 6},${ey + 10} ${lastX + 6},${ey + 10}`
    : `${lastX},${ey + 2} ${lastX - 6},${ey - 10} ${lastX + 6},${ey - 10}`;
  parts.push(`<polygon points="${tri}" fill="${COLORS.entry}" stroke="#ffffff" stroke-width="1"/>`);

  // подписи дат: первая и последняя
  parts.push(`<text x="${padL}" y="${height - 8}" font-size="11" fill="${COLORS.muted}">${esc(dateLabel(shown[0].date, tf))}</text>`);
  parts.push(`<text x="${padL + plotW}" y="${height - 8}" font-size="11" fill="${COLORS.muted}" text-anchor="end">${esc(dateLabel(shown[shown.length - 1].date, tf))}</text>`);

  const dirWord = long ? 'лонг' : 'шорт';
  const head = `<text x="${padL}" y="24" font-size="16" font-weight="700" fill="${COLORS.text}">${esc(ticker)}  ·  ${esc(TF_LABELS[tf] || tf)}</text>`
    + `<text x="${width - padR + 8}" y="24" font-size="13" fill="${COLORS.muted}">${esc(dirWord)}</text>`;
  return `<g transform="translate(0 ${offsetY})">${head}${parts.join('')}</g>`;
}

/**
 * Собрать картинку из одной или двух панелей.
 * @param {object} a
 * @param {string} a.ticker
 * @param {object} a.trade  { direction, entryPrice, stopLoss, takeProfit }
 * @param {Array<{tf:string, candles:Array, signalIndex?:number}>} a.panels
 * @param {number} [a.count=30]
 */
export function buildSignalChartSvg({ ticker, trade, panels, count = 30, width = 900, panelHeight = 400 }) {
  const list = (panels || []).filter((p) => p && p.candles && p.candles.length);
  const height = panelHeight * Math.max(1, list.length);
  const body = list.map((p, i) => panel({
    candles: p.candles, tf: p.tf, trade, ticker, width, height: panelHeight, offsetY: i * panelHeight, count, signalIndex: p.signalIndex,
  })).join('');
  const sep = list.length > 1
    ? `<line x1="14" y1="${panelHeight}" x2="${width - 14}" y2="${panelHeight}" stroke="${COLORS.grid}" stroke-width="2"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">`
    + `<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>${body}${sep}</svg>`;
}
