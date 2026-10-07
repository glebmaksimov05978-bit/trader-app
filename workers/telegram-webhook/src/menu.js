// workers/telegram-webhook/src/menu.js
//
// Меню бота: постоянная клавиатура внизу чата и ответы на её кнопки. Только ЧТЕНИЕ — ни
// одно действие отсюда не открывает и не закрывает сделку (это отдельный, следующий этап
// с двойным подтверждением). Данные берутся из снимка `snap:main`, который раз в проход
// кладёт робот (scripts/telegram/writeSnapshot.mjs).
//
// Кто имеет право спрашивать: только чат, id которого записан в самом снимке (его туда
// кладёт робот из своего TELEGRAM_CHAT_ID). Чужим чатам бот не отвечает вообще — ни ответом
// «нет доступа», ни эхом: молчание не выдаёт, что бот существует и что за ним что-то есть.
import { escapeHtml } from '../../../src/services/alerts.js';

export const MENU_KEYBOARD = {
  keyboard: [
    [{ text: '📈 Сделки' }, { text: '📄 Бумажные' }],
    [{ text: '🎯 Радар' }, { text: '🤖 Робот' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MAX_LINES = 30; // у Telegram потолок 4096 знаков на сообщение

const money = (n) => `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('ru-RU')} ₽`;
const dirWord = (d) => (d === 'short' ? 'шорт' : 'лонг');
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

function positionLine(p) {
  const head = `<b>${escapeHtml(p.ticker)}</b> ${dirWord(p.dir)} ${p.vol}`;
  if (p.price == null) return `${head} · вход ${p.entry} · цены нет`;
  const sign = p.pct > 0 ? '+' : '';
  return `${head} · ${p.entry} → ${p.price} · ${p.pnl != null ? money(p.pnl) : '—'} (${sign}${p.pct}%)`;
}

function positionsText(title, list, at) {
  if (!list.length) return `<b>${title}</b>\nОткрытых нет.\n\n<i>Данные на ${fmtTime(at)} (${ago(at)})</i>`;
  const total = list.reduce((s, p) => s + (p.pnl || 0), 0);
  const lines = list.slice(0, MAX_LINES).map(positionLine);
  if (list.length > MAX_LINES) lines.push(`… и ещё ${list.length - MAX_LINES}`);
  return `<b>${title}</b>\n${lines.join('\n')}\n\nИтого плавающий результат: <b>${money(total)}</b>\n<i>Данные на ${fmtTime(at)} (${ago(at)})</i>`;
}

/**
 * Кнопки под списком: «Закрыть X» под открытыми сделками и «Открыть реально: X» под бумажными.
 * Сами по себе ничего не отправляют — открывают шаг подтверждения (см. tgTrade.js). Данные кнопки
 * несут id записи, а не цифры: объём и сторону бот берёт из позиции у брокера.
 */
export function menuButtons(command, snap) {
  const MAX = 8;
  if (command === 'real') {
    const rows = (snap.real || []).filter((p) => p.id).slice(0, MAX)
      .map((p) => [{ text: `📉 Закрыть ${p.ticker}`, callback_data: `x|c|${p.id}` }]);
    return rows.length ? { inline_keyboard: rows } : null;
  }
  if (command === 'paper') {
    const rows = (snap.paper || []).filter((p) => p.id).slice(0, MAX)
      .map((p) => [{ text: `🔁 Открыть реально: ${p.ticker}`, callback_data: `x|o|${p.id}` }]);
    return rows.length ? { inline_keyboard: rows } : null;
  }
  return null;
}

export function renderMenuReply(command, snap) {
  switch (command) {
    case 'real':
      return positionsText('📈 Открытые сделки', snap.real || [], snap.at);
    case 'paper': {
      const base = positionsText('📄 Бумажные сделки (открытые)', snap.paper || [], snap.at);
      const c = snap.paperClosed;
      if (!c?.count) return base;
      const last = (c.last || []).map((x) => `${escapeHtml(x.ticker)} ${money(x.pnl)}`).join(', ');
      return `${base}\n\nЗакрыто всего: ${c.count}, итог ${money(c.pnl)}${last ? `\nПоследние: ${last}` : ''}`;
    }
    case 'radar': {
      const rows = (snap.radar || []);
      if (!rows.length) return '<b>🎯 Радар</b>\nСписок пуст.';
      const lines = rows.slice(0, MAX_LINES).map((r) => (r.robot
        ? `<b>${escapeHtml(r.ticker)}</b> — ${escapeHtml(r.robot.text)}`
        : `<b>${escapeHtml(r.ticker)}</b> — робот ещё не проверял`));
      return `<b>🎯 Радар: что решил робот</b>\n${lines.join('\n')}\n\n<i>Данные на ${fmtTime(snap.at)} (${ago(snap.at)})</i>`;
    }
    case 'robot': {
      const last = snap.robot?.lastCheckAt;
      const stale = last ? (Date.now() - new Date(last).getTime()) > 45 * 60000 : true;
      return `<b>🤖 Робот</b>\nПоследняя проверка радара: ${fmtTime(last)} (${ago(last)})\nТикеров в радаре: ${snap.robot?.radarCount ?? 0}\n`
        + `Открытых сделок: ${(snap.real || []).length}, бумажных: ${(snap.paper || []).length}\n`
        + (stale
          ? '\n⚠️ Данных давно не было. Это нормально, если биржа закрыта; если торги идут — робот не отрабатывает, проверь во вкладке Actions на GitHub.'
          : '\nВсё в порядке: робот отрабатывает.');
    }
    default:
      return null;
  }
}

// Текст кнопки/команды → ключ ответа. Принимаем и обычные слова — на случай, если клавиатура
// скрыта и трейдер набирает руками.
export function commandOf(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('бумажн') || t.startsWith('/paper')) return 'paper';
  if (t.includes('сделки') || t.startsWith('/trades') || t.startsWith('/real')) return 'real';
  if (t.includes('радар') || t.startsWith('/radar')) return 'radar';
  if (t.includes('робот') || t.startsWith('/robot') || t.startsWith('/status')) return 'robot';
  if (t.startsWith('/start') || t.startsWith('/menu') || t.includes('меню')) return 'start';
  return null;
}
