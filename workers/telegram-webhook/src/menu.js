// workers/telegram-webhook/src/menu.js
//
// Меню бота: постоянная клавиатура внизу чата и ответы на её кнопки. Сам по себе экран только
// ПОКАЗЫВАЕТ данные; открыть или закрыть реальную позицию можно кнопками под сделкой — они ведут
// на шаг подтверждения (tgTrade.js) и ничего не отправляют брокеру без вашего «Да».
// Данные берутся из снимка `snap:main`, который раз в проход кладёт робот
// (scripts/telegram/writeSnapshot.mjs).
//
// Как устроено меню:
//   «Реальные» / «Бумажные» → выбор стратегии → список её сделок (открытые + последние закрытые)
//   → карточка конкретной сделки (вход, цена, стоп, цель, кнопки «Открыть в приложении», «Открыть
//   реально» / «Закрыть»). Все переходы внутри — правка того же сообщения, чат не засоряется.
//
// Кто имеет право спрашивать: только чат, id которого записан в самом снимке (его туда
// кладёт робот из своего TELEGRAM_CHAT_ID). Чужим чатам бот не отвечает вообще — ни ответом
// «нет доступа», ни эхом: молчание не выдаёт, что бот существует и что за ним что-то есть.
import { escapeHtml, appTradeUrl, appPageUrl } from '../../../src/services/alerts.js';

export const MENU_KEYBOARD = {
  keyboard: [
    [{ text: 'Реальные' }, { text: 'Бумажные' }],
    [{ text: 'Радар' }, { text: 'Робот' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MAX_LINES = 30;          // у Telegram потолок 4096 знаков на сообщение
const MAX_OPEN_ROWS = 15;      // открытых сделок в одном списке
const MAX_CLOSED_ROWS = 8;     // закрытых сделок в одном списке
const MAX_BUTTONS = 12;        // кнопок-сделок под списком

const MINUS = '−';
const nf = (n, d = 0) => Math.abs(n).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => `${n > 0 ? '+' : n < 0 ? MINUS : ''}${nf(Math.round(n))} ₽`;
const pctText = (p) => (p == null ? '—' : `${p > 0 ? '+' : p < 0 ? MINUS : ''}${nf(p, 1)}%`);
const dirWord = (d) => (d === 'short' ? 'шорт' : 'лонг');
const num = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }));
const fmtTime = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const ago = (iso) => {
  if (!iso) return 'нет данных';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  if (min < 1440) return `${Math.round(min / 60)} ч назад`;
  return `${Math.round(min / 1440)} дн назад`;
};
const stamp = (snap) => `<i>Данные на ${fmtTime(snap.at)} (${ago(snap.at)})</i>`;

/** Короткий устойчивый код стратегии (для данных кнопок: у Telegram лимит 64 байта). */
export function strategyCode(name) {
  let h = 5381;
  for (const ch of String(name || '')) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return h.toString(36).slice(0, 6);
}

const TF_LABEL = { M5: 'М5', M10: 'М10', M15: 'М15', H1: 'Ч1', D1: 'Д1', W1: 'Н1' };
const tfLabel = (k) => TF_LABEL[k] || k;
const tfList = (set) => [...set].map(tfLabel).filter((v, i, a) => a.indexOf(v) === i).join(', ');

const NO_STRATEGY = 'Без стратегии';
const stratOf = (p) => p.strategy || NO_STRATEGY;

// ── данные режима ────────────────────────────────────────────────────────────

const MODES = {
  p: { key: 'paper', closedKey: 'paperClosedList', summaryKey: 'paperByStrategy', title: 'Бумажные сделки', short: 'бумажная' },
  r: { key: 'real', closedKey: 'realClosedList', summaryKey: 'realByStrategy', title: 'Реальные сделки', short: 'реальная' },
};

/** Группы по стратегиям: открытые, сводка закрытых (за всё время, если она есть в снимке). */
function groupsOf(mode, snap) {
  const m = MODES[mode];
  const open = snap[m.key] || [];
  const summary = snap[m.summaryKey] || [];
  const closedList = snap[m.closedKey] || [];
  const map = new Map();
  const get = (label) => {
    if (!map.has(label)) map.set(label, { label, sk: strategyCode(label), open: [], closedRows: [], summary: null, tfs: new Set() });
    return map.get(label);
  };
  for (const p of open) { const g = get(stratOf(p)); g.open.push(p); if (p.tf) g.tfs.add(p.tf); }
  for (const s of summary) { const g = get(s.label || NO_STRATEGY); g.summary = s; (s.timeframes || []).forEach((t) => g.tfs.add(t)); }
  for (const c of closedList) get(stratOf(c)).closedRows.push(c);
  return [...map.values()].sort((a, b) => (b.open.length - a.open.length) || a.label.localeCompare(b.label));
}

const floating = (list) => list.reduce((s, p) => s + (p.pnl || 0), 0);

/** Строки таблицы «лево — подписи, право — числа» в моноширинном блоке. */
function kv(rows) {
  const w = Math.max(...rows.map((r) => r[0].length));
  const v = Math.max(...rows.map((r) => r[1].length));
  return rows.map((r) => `${r[0].padEnd(w)}  ${r[1].padStart(v)}${r[2] ? `  ${r[2]}` : ''}`).join('\n');
}

function openRow(p) {
  return `${String(p.ticker).padEnd(6)} ${dirWord(p.dir)} ${(p.pnl != null ? money(p.pnl) : 'нет цены').padStart(10)} ${pctText(p.pct).padStart(7)}`;
}
function closedRow(c) {
  return `${String(c.ticker).padEnd(6)} ${dirWord(c.dir)} ${money(c.pnl || 0).padStart(10)} ${pctText(c.pct).padStart(7)}`;
}
const pre = (lines) => `<pre>${escapeHtml(lines.join('\n'))}</pre>`;

// ── экраны ───────────────────────────────────────────────────────────────────

/** Выбор стратегии: по строке на каждую + кнопки. */
function overview(mode, snap) {
  const m = MODES[mode];
  const groups = groupsOf(mode, snap);
  if (!groups.length) {
    return { text: `<b>${m.title}</b>\nОткрытых нет.\n\n${stamp(snap)}`, keyboard: null };
  }
  if (groups.length === 1) return listView(mode, groups[0].sk, snap, { single: true });
  const blocks = groups.map((g) => {
    const tf = g.tfs.size ? ` · ${escapeHtml(tfList(g.tfs))}` : '';
    const s = g.summary;
    const closed = s && s.closed ? `закрыто ${s.closed}, итог ${money(s.pnl)}` : 'закрытых пока нет';
    return `<b>${escapeHtml(g.label)}</b>${tf}\nоткрыто ${g.open.length}${g.open.length ? `, плавает ${money(floating(g.open))}` : ''} · ${closed}`;
  });
  const rows = groups.slice(0, 10).map((g) => [{ text: `${g.label} · ${g.open.length} откр.`.slice(0, 60), callback_data: `m|l|${mode}|${g.sk}` }]);
  rows.push([{ text: 'Все открытые сразу', callback_data: `m|l|${mode}|all` }]);
  return {
    text: `<b>${m.title}</b> — выберите стратегию\n\n${blocks.join('\n\n')}\n\n<i>Итоги считаются по каждой стратегии отдельно: у них разный горизонт, их не сравнивают.</i>\n${stamp(snap)}`,
    keyboard: { inline_keyboard: rows },
  };
}

/** Список сделок одной стратегии (или всех открытых). */
function listView(mode, sk, snap, { single = false } = {}) {
  const m = MODES[mode];
  const groups = groupsOf(mode, snap);
  const backRow = single || groups.length <= 1 ? [] : [[{ text: '← К стратегиям', callback_data: `m|l|${mode}|` }]];

  if (sk === 'all') {
    const parts = [];
    let n = 0;
    for (const g of groups) {
      if (!g.open.length) continue;
      const rows = g.open.slice(0, Math.max(0, 25 - n)).map(openRow);
      n += rows.length;
      if (rows.length) parts.push(`<b>${escapeHtml(g.label)}</b>\n${pre(rows)}`);
    }
    const buttons = tradeButtons(mode, groups.flatMap((g) => g.open), sk);
    return {
      text: `<b>${m.title}</b> · все открытые\n\n${parts.length ? parts.join('\n') : 'Открытых нет.'}\n${stamp(snap)}`,
      keyboard: { inline_keyboard: [...buttons, ...backRow] },
    };
  }

  const g = groups.find((x) => x.sk === sk);
  if (!g) return { text: 'Стратегия не найдена в последнем снимке — откройте раздел заново.', keyboard: null };

  const s = g.summary;
  const head = [];
  head.push(['Открыто', String(g.open.length), g.open.length ? `плавает ${money(floating(g.open))}` : '']);
  if (s && s.closed) {
    head.push(['Закрыто', String(s.closed), '']);
    head.push(['Итог закрытых', money(s.pnl), '']);
    if (s.winrate != null) head.push(['Прибыльных', `${s.winrate}%`, '']);
  } else {
    head.push(['Закрыто', '0', '']);
  }
  const tf = g.tfs.size ? ` · ${escapeHtml(tfList(g.tfs))}` : '';
  const out = [`<b>${escapeHtml(g.label)}</b>${tf}\n<i>${m.title.toLowerCase()}</i>\n\n${pre(kv(head).split('\n'))}`];

  if (g.open.length) {
    out.push(`<b>Открытые</b>\n${pre(g.open.slice(0, MAX_OPEN_ROWS).map(openRow))}`);
    if (g.open.length > MAX_OPEN_ROWS) out.push(`… и ещё ${g.open.length - MAX_OPEN_ROWS}`);
  }
  if (g.closedRows.length) {
    out.push(`<b>Закрытые (последние ${Math.min(g.closedRows.length, MAX_CLOSED_ROWS)})</b>\n${pre(g.closedRows.slice(0, MAX_CLOSED_ROWS).map(closedRow))}`);
  }
  out.push(stamp(snap));
  return { text: out.join('\n\n'), keyboard: { inline_keyboard: [...tradeButtons(mode, g.open, sk), ...backRow] } };
}

/** Кнопки-тикеры под списком: по три в ряд. */
function tradeButtons(mode, open, sk) {
  const rows = [];
  const list = open.filter((p) => p.id).slice(0, MAX_BUTTONS);
  for (let i = 0; i < list.length; i += 3) {
    rows.push(list.slice(i, i + 3).map((p) => ({ text: String(p.ticker), callback_data: `m|t|${mode}|${p.id}` })));
  }
  return rows;
}

/** Карточка одной открытой сделки. */
function tradeView(mode, id, snap, appUrl) {
  const m = MODES[mode];
  const p = (snap[m.key] || []).find((x) => x.id === id);
  if (!p) return { text: 'Сделки нет в последнем снимке — возможно, она уже закрыта. Откройте раздел заново.', keyboard: null };
  const back = `m|l|${mode}|${strategyCode(stratOf(p))}`;
  const rows = [['Вход', num(p.entry), '']];
  rows.push(['Сейчас', p.price != null ? num(p.price) : 'нет цены', p.pct != null ? pctText(p.pct) : '']);
  const toStop = p.stop != null && p.entry ? ((p.dir === 'short' ? p.entry - p.stop : p.stop - p.entry) / p.entry) * 100 : null;
  const toTake = p.take != null && p.entry ? ((p.dir === 'short' ? p.entry - p.take : p.take - p.entry) / p.entry) * 100 : null;
  rows.push(['Стоп', p.stop != null ? num(p.stop) : 'нет', toStop != null ? pctText(toStop) : '']);
  rows.push(['Цель', p.take != null ? num(p.take) : 'нет', toTake != null ? pctText(toTake) : '']);
  rows.push(['Объём', num(p.vol), '']);
  rows.push(['Результат', p.pnl != null ? money(p.pnl) : '—', '']);
  const sub = [p.strategy ? `«${escapeHtml(p.strategy)}»` : null, p.tf ? escapeHtml(tfLabel(p.tf)) : null, p.openedAt ? `открыта ${fmtTime(p.openedAt)}` : null, p.phase ? escapeHtml(p.phase) : null]
    .filter(Boolean).join(' · ');
  const text = `<b>${escapeHtml(p.ticker)} · ${dirWord(p.dir)}</b>  ${m.short}\n<i>${sub}</i>\n\n${pre(kv(rows).split('\n'))}\n${stamp(snap)}`;
  const action = mode === 'r'
    ? { text: 'Закрыть позицию', callback_data: `x|c|${p.id}` }
    : { text: 'Открыть реально', callback_data: `x|o|${p.id}` };
  return {
    text,
    keyboard: { inline_keyboard: [[{ text: 'Открыть в приложении', url: appTradeUrl(p.id, appUrl) }], [action], [{ text: '← К списку', callback_data: back }]] },
  };
}

/** Разбор данных кнопки меню (m|l|p|<код>, m|t|r|<id>) → описание экрана. */
export function parseMenuCallback(data) {
  const parts = String(data || '').split('|');
  if (parts[0] !== 'm') return null;
  if (parts[1] === 'l' && MODES[parts[2]]) return { kind: 'list', mode: parts[2], sk: parts[3] || '' };
  if (parts[1] === 't' && MODES[parts[2]] && parts[3]) return { kind: 'trade', mode: parts[2], id: parts[3] };
  return null;
}

/** Экран по описанию кнопки → { text, keyboard }. */
export function renderMenuView(view, snap, appUrl) {
  if (view.kind === 'trade') return tradeView(view.mode, view.id, snap, appUrl);
  if (!view.sk) return overview(view.mode, snap);
  return listView(view.mode, view.sk, snap);
}

// ── экраны верхнего уровня ───────────────────────────────────────────────────

/** Ответ на кнопку нижней клавиатуры → { text, keyboard } (keyboard — инлайн, под сообщением). */
export function menuReply(command, snap) {
  switch (command) {
    case 'real': return overview('r', snap);
    case 'paper': return overview('p', snap);
    case 'radar': return { text: renderMenuReply('radar', snap), keyboard: null };
    case 'robot': return { text: renderMenuReply('robot', snap), keyboard: null };
    default: return null;
  }
}

/** Только текст ответа (радар, робот — и общий обзор, для проверок). */
export function renderMenuReply(command, snap) {
  switch (command) {
    case 'real': return overview('r', snap).text;
    case 'paper': return overview('p', snap).text;
    case 'radar': {
      const rows = (snap.radar || []);
      if (!rows.length) return '<b>Радар</b>\nСписок пуст.';
      const lines = rows.slice(0, MAX_LINES).map((r) => (r.robot
        ? `<b>${escapeHtml(r.ticker)}</b> — ${escapeHtml(r.robot.text)}`
        : `<b>${escapeHtml(r.ticker)}</b> — робот ещё не проверял`));
      return `<b>Радар: что решил робот</b>\n${lines.join('\n')}\n\n${stamp(snap)}`;
    }
    case 'robot': {
      const last = snap.robot?.lastCheckAt;
      const stale = last ? (Date.now() - new Date(last).getTime()) > 45 * 60000 : true;
      const rows = [
        ['Проверка радара', fmtTime(last), ago(last)],
        ['Тикеров в радаре', String(snap.robot?.radarCount ?? 0), ''],
        ['Открытых сделок', String((snap.real || []).length), ''],
        ['Бумажных', String((snap.paper || []).length), ''],
      ];
      return `<b>Робот</b>\n${pre(kv(rows).split('\n'))}`
        + (stale
          ? '\nВнимание: данных давно не было. Это нормально, если биржа закрыта; если торги идут — робот не отрабатывает, проверьте вкладку Actions на GitHub.'
          : '\nВсё в порядке: робот отрабатывает.');
    }
    default:
      return null;
  }
}

export const START_TEXT = '<b>TraderPro</b>\nМеню внизу: реальные и бумажные сделки по стратегиям, радар, состояние робота.\n'
  + 'Под сделкой есть кнопка «Открыть в приложении»; реальную позицию можно открыть или закрыть отсюда — только после вашего подтверждения.';

/** Ссылка на отчёт в приложении (для подвала экрана «Робот»/справки). */
export const reportUrl = (appUrl) => appPageUrl('/report', appUrl);

// Текст кнопки/команды → ключ ответа. Принимаем и обычные слова — на случай, если клавиатура
// скрыта и трейдер набирает руками; старые подписи кнопок («📈 Сделки», «🧪 Стратегии») тоже понятны.
export function commandOf(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('бумажн') || t.startsWith('/paper') || t.includes('стратег') || t.startsWith('/strategies')) return 'paper';
  if (t.includes('реальн') || t.includes('сделки') || t.startsWith('/trades') || t.startsWith('/real')) return 'real';
  if (t.includes('радар') || t.startsWith('/radar')) return 'radar';
  if (t.includes('робот') || t.startsWith('/robot') || t.startsWith('/status')) return 'robot';
  if (t.startsWith('/start') || t.startsWith('/menu') || t.includes('меню')) return 'start';
  return null;
}

/**
 * Совместимость со старым кодом воркера: кнопки действий под списком. Новое меню даёт кнопки
 * внутри menuReply/renderMenuView, поэтому здесь — пусто.
 */
export function menuButtons() { return null; }
