// scripts/telegram/signalPhoto.mjs
//
// Картинка графика для сообщения о входе: таймфрейм стратегии + следующий за ним, ~30 свечей,
// линии входа/стопа/цели. Рисование — src/services/telegram/chartImage.js (чистый SVG), здесь —
// сбор свечей, перевод в PNG и отправка в Telegram.
//
// Всё «тихое»: нет библиотеки перевода в PNG, нет свечей или Telegram не принял картинку —
// функции возвращают null/false, а сообщение о сигнале всё равно уходит текстом. Сделка к этому
// моменту уже записана, картинка — только украшение.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-photo-'));
function esmify(src) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
const chart = await import(esmify(path.join(repoRoot, 'src/services/telegram/chartImage.js')));
export const { nextTimeframe, aggregateWeekly, buildSignalChartSvg } = chart;

const CANDLES_SHOWN = 30;

/** Индекс последней свечи, начавшейся не позже момента signalMs (для подсветки сигнальной свечи). */
function indexAtOrBefore(candles, signalMs) {
  let idx = -1;
  candles.forEach((c, i) => { if (new Date(c.date).getTime() <= signalMs) idx = i; });
  return idx;
}

/**
 * Собрать SVG для сигнала.
 * @param {object} a
 * @param {string} a.ticker
 * @param {object} a.trade   { direction, entryPrice, stopLoss, takeProfit }
 * @param {string} a.tfKey   таймфрейм стратегии
 * @param {Date|string|number} a.signalDate  дата сигнальной свечи
 * @param {(tf:string)=>Promise<Array>} a.getCandles  свечи нужного таймфрейма (D1/H1/…), по возрастанию
 * @returns {Promise<string|null>}
 */
export async function buildSignalSvg({ ticker, trade, tfKey, signalDate, getCandles }) {
  const signalMs = new Date(signalDate).getTime();
  const panels = [];
  const main = await getCandles(tfKey);
  if (main && main.length >= 5) {
    const shown = main.slice(-CANDLES_SHOWN);
    panels.push({ tf: tfKey, candles: main, signalIndex: indexAtOrBefore(shown, signalMs) });
  }
  const next = nextTimeframe(tfKey);
  try {
    const raw = next === 'W1' ? await getCandles('D1') : await getCandles(next);
    const higher = next === 'W1' ? aggregateWeekly(raw || []) : raw;
    if (higher && higher.length >= 5) {
      const shown = higher.slice(-CANDLES_SHOWN);
      panels.push({ tf: next, candles: higher, signalIndex: indexAtOrBefore(shown, signalMs) });
    }
  } catch { /* старший таймфрейм не загрузился — обойдёмся одной панелью */ }
  if (!panels.length) return null;
  return buildSignalChartSvg({ ticker, trade, panels, count: CANDLES_SHOWN });
}

/** SVG → PNG (Buffer). Нет библиотеки — null. */
export async function renderPng(svg) {
  let Resvg;
  try { ({ Resvg } = await import('@resvg/resvg-js')); } catch { return null; }
  try {
    const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: 1.4 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } });
    return r.render().asPng();
  } catch (e) {
    console.error(`PNG: ${e.message}`);
    return null;
  }
}

/** Отправить PNG в Telegram как фото. */
export async function sendPhoto({ token, chatId, png, caption = '', apiBase = 'https://api.telegram.org', fetchImpl = fetch }) {
  if (!token || !chatId || !png) return false;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    form.append('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
    const res = await fetchImpl(`${apiBase}/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const data = await res.json();
    if (!data.ok) { console.error(`Telegram sendPhoto: ${data.description || res.status}`); return false; }
    return true;
  } catch (e) {
    console.error(`Telegram sendPhoto: ${e.message}`);
    return false;
  }
}

/** Всё сразу: свечи → SVG → PNG → фото. Возвращает true, если фото ушло. */
export async function sendSignalPhoto({ token, chatId, apiBase, caption, ...chartArgs }) {
  try {
    const svg = await buildSignalSvg(chartArgs);
    if (!svg) return false;
    const png = await renderPng(svg);
    if (!png) return false;
    return await sendPhoto({ token, chatId, png, caption, apiBase });
  } catch (e) {
    console.error(`Картинка сигнала: ${e.message}`);
    return false;
  }
}
