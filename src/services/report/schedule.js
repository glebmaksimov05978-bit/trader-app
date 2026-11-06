// src/services/report/schedule.js
//
// Расписание автоотправки отчёта: когда слать (каждую неделю / каждый месяц / один раз в выбранную дату), за какой период и что
// внутри. Чистые функции без зависимостей — их используют и окно настройки в приложении, и фоновый робот (scripts/reports/…).
//
// Время — по Москве (как и всё в роботах). Робота будят будильники каждые 15 минут с 07:00 до 23:45 МСК, поэтому отправка идёт
// «при первом проходе после выбранного часа» и в тот же день, если сегодня ещё не слали (отметка lastSentOn). Если робот в нужный
// час молчал, отчёт придёт при следующем проходе ТОГО ЖЕ дня; на следующий день он уже не «догоняет» (кроме разовой отправки
// «сейчас» — sendNowAt).
import { PERIOD_PRESETS, SECTIONS, DEFAULT_SECTIONS } from './exportReport.js';

export const MSK_MS = 3 * 3600 * 1000;
export const MSK_TZ = 'Europe/Moscow';
export const MAX_SCHEDULES = 5;
export const HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]; // окно, когда работают будильники
export const SCHEDULE_PERIODS = ['last_week', 'last_month', 'last_quarter', 'last_year', 'this_week', 'this_month', 'this_quarter', 'this_year', 'last_30', 'last_90'];
export const WEEKDAYS = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const EVERY = ['Каждый', 'Каждый', 'Каждую', 'Каждый', 'Каждую', 'Каждую', 'Каждое'];
export const FREQUENCIES = [
  { id: 'weekly', label: 'Каждую неделю' },
  { id: 'monthly', label: 'Каждый месяц' },
  { id: 'once', label: 'Один раз' },
];

// Куда можно присылать отчёт. Telegram работает всегда (чат робота); почта и MAX — когда в роботе заданы ключи (GitHub Secrets),
// об этом робот сообщает приложению в профиле (reportDelivery), чтобы не обещать то, что не подключено.
export const CHANNELS = [
  { id: 'telegram', label: 'Telegram', hint: 'PDF-файлом в чат робота — туда же, где уведомления' },
  { id: 'email', label: 'Почта', hint: 'PDF-файлом во вложении письма' },
  { id: 'max', label: 'MAX', hint: 'PDF-файлом в личный чат с ботом в MAX' },
];
export const CHANNEL_IDS = CHANNELS.map((c) => c.id);
export const channelLabel = (id) => CHANNELS.find((c) => c.id === id)?.label || id;
/** «Отправить сейчас» живёт сутки: если за это время доставить не удалось, запрос считается устаревшим (иначе робот пытался бы вечно). */
export const MANUAL_TTL_MS = 24 * 3600 * 1000;

/** Один адрес электронной почты: без пробелов, переводов строк, запятых и точек с запятой (защита от «двух получателей» и вставки заголовков). */
export function isValidEmail(v) {
  return typeof v === 'string' && v.length <= 120 && /^[^\s@,;<>"'\\]+@[^\s@,;<>"'\\]+\.[^\s@,;<>"'\\.]{2,}$/.test(v);
}

/** Ждёт ли расписание запроса «Отправить сейчас» (свежий — не старше суток — и новее последней отправки). */
export function manualPending(s, state, nowMs) {
  return !!(s.sendNowAt && s.sendNowAt > (state?.lastSentAt || 0) && nowMs - s.sendNowAt < MANUAL_TTL_MS);
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// ---- часовые пояса ----
// Расписание живёт в часовом поясе, который выбрал пользователь (по умолчанию — Москва). Робот работает по Москве (07:00–23:45),
// поэтому в других поясах доступны только те часы, на которые он успевает (hoursForZone).
const fmtCache = new Map();
function zoneFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Существует ли такой часовой пояс (например «Asia/Yekaterinburg»). */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 60) return false;
  try { zoneFormatter(tz); return true; } catch { return false; }
}

/** Сдвиг часового пояса от UTC (мс) в момент ms — с учётом летнего времени. */
export function zoneOffsetMs(tz, ms) {
  if (!tz || tz === MSK_TZ) return MSK_MS;
  const parts = zoneFormatter(tz).formatToParts(new Date(ms));
  const g = (type) => Number(parts.find((q) => q.type === type).value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Местное время (год, месяц 0–11, число, час) в поясе tz → момент в UTC (мс). */
export function zonedToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m, d, h);
  const first = guess - zoneOffsetMs(tz, guess);
  return guess - zoneOffsetMs(tz, first);
}

/** Подпись пояса: «UTC+3», «UTC+5:30». */
export function utcLabel(tz, atMs = Date.now()) {
  const min = Math.round(zoneOffsetMs(tz, atMs) / 60000);
  const sign = min < 0 ? '−' : '+';
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/** Часы (местные), на которые робот успевает: ему нужно окно 07:00–23:45 по Москве. */
export function hoursForZone(tz, atMs = Date.now()) {
  const delta = Math.round((zoneOffsetMs(tz, atMs) - MSK_MS) / 3600000); // на сколько часов пояс «впереди» Москвы
  return Array.from({ length: 24 }, (_, h) => h).filter((h) => {
    const msk = (((h - delta) % 24) + 24) % 24;
    return msk >= 7 && msk <= 22;
  });
}

/** Дата (YYYY-MM-DD), час, день недели (Пн=0) и число месяца для момента nowMs в поясе tz (по умолчанию — Москва). */
export function mskParts(nowMs, tz = MSK_TZ) {
  const d = new Date(nowMs + zoneOffsetMs(tz, nowMs));
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hour: d.getUTCHours(), dow: (d.getUTCDay() + 6) % 7,
    dim: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(),
  };
}

const newId = () => `rs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function defaultSchedule(over = {}) {
  return {
    id: newId(), enabled: true, name: '',
    frequency: 'monthly', dayOfWeek: 0, dayOfMonth: 1, date: '', hour: 9,
    period: 'last_month', scope: 'real', strategies: [], sections: DEFAULT_SECTIONS.slice(),
    channels: ['telegram'], email: '', sendNowAt: null, tz: MSK_TZ,
    ...over,
  };
}

/** Привести сохранённое (возможно, неполное или испорченное) расписание к допустимому виду; null — если безнадёжно. */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = defaultSchedule({ id: typeof raw.id === 'string' && raw.id ? raw.id : newId() });
  const s = { ...base };
  s.enabled = raw.enabled !== false;
  s.name = typeof raw.name === 'string' ? raw.name.slice(0, 60) : '';
  s.frequency = FREQUENCIES.some((f) => f.id === raw.frequency) ? raw.frequency : 'monthly';
  s.dayOfWeek = Number.isInteger(raw.dayOfWeek) && raw.dayOfWeek >= 0 && raw.dayOfWeek <= 6 ? raw.dayOfWeek : 0;
  s.dayOfMonth = raw.dayOfMonth === 'last' ? 'last' : (Number.isInteger(raw.dayOfMonth) && raw.dayOfMonth >= 1 && raw.dayOfMonth <= 28 ? raw.dayOfMonth : 1);
  s.date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : '';
  s.tz = isValidTimeZone(raw.tz) ? raw.tz : MSK_TZ;
  s.hour = hoursForZone(s.tz).includes(raw.hour) ? raw.hour : (hoursForZone(s.tz).includes(9) ? 9 : hoursForZone(s.tz)[0]);
  s.period = SCHEDULE_PERIODS.includes(raw.period) ? raw.period : (s.frequency === 'weekly' ? 'last_week' : 'last_month');
  s.scope = ['real', 'paper', 'all'].includes(raw.scope) ? raw.scope : 'real';
  s.strategies = Array.isArray(raw.strategies) ? raw.strategies.filter((x) => typeof x === 'string').slice(0, 30) : [];
  const ids = SECTIONS.map((x) => x.id);
  const secs = Array.isArray(raw.sections) ? raw.sections.filter((x) => ids.includes(x)) : [];
  s.sections = secs.length ? secs : DEFAULT_SECTIONS.slice();
  s.email = isValidEmail(typeof raw.email === 'string' ? raw.email.trim() : '') ? raw.email.trim() : '';
  const ch = Array.isArray(raw.channels) ? raw.channels.filter((x, i, a) => CHANNEL_IDS.includes(x) && a.indexOf(x) === i) : [];
  // почта без корректного адреса — не канал; ничего не выбрано (или старая запись без каналов) — как раньше, только Telegram
  const okCh = ch.filter((x) => x !== 'email' || s.email);
  s.channels = okCh.length ? okCh : ['telegram'];
  s.sendNowAt = Number.isFinite(raw.sendNowAt) ? raw.sendNowAt : null;
  if (s.frequency === 'once' && !s.date) return null; // разовая без даты — смысла нет
  return s;
}

/** Нормализованный список (не больше MAX_SCHEDULES), испорченные записи отбрасываются. */
export function normalizeSchedules(list) {
  return (Array.isArray(list) ? list : []).map(normalizeSchedule).filter(Boolean).slice(0, MAX_SCHEDULES);
}

function dueDay(s, p) {
  if (s.frequency === 'weekly') return p.dow === s.dayOfWeek;
  if (s.frequency === 'monthly') return p.d === (s.dayOfMonth === 'last' ? p.dim : Math.min(s.dayOfMonth, p.dim));
  if (s.frequency === 'once') return p.date === s.date;
  return false;
}

/**
 * Пора ли слать сейчас.
 * @param {object} s — нормализованное расписание
 * @param {number} nowMs
 * @param {{lastSentOn?: string|null, lastSentAt?: number|null}} [state] — что робот уже отправлял
 * @returns {{send: boolean, reason: string, manual?: boolean}}
 */
export function isScheduleDue(s, nowMs, state = {}) {
  if (!s.enabled) return { send: false, reason: 'выключено' };
  // «Отправить сейчас»: запрос новее последней отправки — слать на ближайшем проходе, расписание не нужно
  if (manualPending(s, state, nowMs)) return { send: true, reason: 'по запросу «Отправить сейчас»', manual: true };
  const p = mskParts(nowMs, s.tz);
  if (s.frequency === 'once' && state.lastSentOn) return { send: false, reason: 'разовая отправка уже состоялась' };
  if (!dueDay(s, p)) return { send: false, reason: 'сегодня не день отправки' };
  if (p.hour < s.hour) return { send: false, reason: `ещё рано (${p.hour}:00 МСК, нужно с ${s.hour}:00)` };
  if (state.lastSentOn === p.date) return { send: false, reason: 'сегодня уже отправлено' };
  return { send: true, reason: 'по расписанию' };
}

/** Ближайший момент отправки (мс) — для надписи «Следующая отправка». null: больше не будет (разовая уже прошла) или выключено. */
export function nextRunAt(s, nowMs, state = {}) {
  if (!s.enabled) return null;
  if (manualPending(s, state, nowMs)) return nowMs;
  if (s.frequency === 'once' && state.lastSentOn) return null;
  const tz = s.tz || MSK_TZ;
  const now = mskParts(nowMs, tz);                          // сегодняшняя дата в поясе расписания
  for (let i = 0; i <= 400; i++) {
    const cal = new Date(Date.UTC(now.y, now.m, now.d + i)); // календарные сутки без привязки к поясу
    const p = {
      date: `${cal.getUTCFullYear()}-${pad(cal.getUTCMonth() + 1)}-${pad(cal.getUTCDate())}`,
      y: cal.getUTCFullYear(), m: cal.getUTCMonth(), d: cal.getUTCDate(), dow: (cal.getUTCDay() + 6) % 7,
      dim: new Date(Date.UTC(cal.getUTCFullYear(), cal.getUTCMonth() + 1, 0)).getUTCDate(),
    };
    if (!dueDay(s, p)) continue;
    const at = zonedToUtc(p.y, p.m, p.d, s.hour, tz);
    if (i === 0) {
      if (state.lastSentOn === p.date) continue;           // сегодня уже отправлено — смотрим дальше
      return Math.max(at, nowMs);                          // сегодня и ещё не слали: час наступил — «сейчас», иначе в назначенный час
    }
    return at;
  }
  return null;
}

const PERIOD_WORDS = {
  last_week: 'прошлую неделю', this_week: 'текущую неделю (с понедельника)', last_month: 'прошлый месяц', this_month: 'текущий месяц (с 1-го числа)',
  last_quarter: 'прошлый квартал', this_quarter: 'текущий квартал (с его начала)', last_year: 'прошлый год', this_year: 'текущий год (с 1 января)',
  last_30: 'последние 30 дней', last_90: 'последние 90 дней',
};
export const periodWords = (id) => PERIOD_WORDS[id] || (PERIOD_PRESETS.find((p) => p.id === id)?.label || id).toLowerCase();

// Час с пометкой пояса, если он не московский: «9:00 (UTC+5)»
const hhmm = (h, s) => `${h}:00${s && s.tz && s.tz !== MSK_TZ ? ` (${utcLabel(s.tz)})` : ''}`;
export function describeWhen(s) {
  if (s.frequency === 'weekly') return `${EVERY[s.dayOfWeek]} ${WEEKDAYS[s.dayOfWeek]} в ${hhmm(s.hour, s)}`;
  if (s.frequency === 'monthly') return s.dayOfMonth === 'last' ? `В последний день каждого месяца в ${hhmm(s.hour, s)}` : `Каждый месяц, ${s.dayOfMonth}-го числа, в ${hhmm(s.hour, s)}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date || '');
  return m ? `Один раз: ${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1]} ${m[1]} в ${hhmm(s.hour, s)}` : 'Один раз (дата не выбрана)';
}
/** «Telegram, почта you@mail.ru» — куда уйдёт отчёт. */
export const describeChannels = (s) => (s.channels || ['telegram']).map((id) => (id === 'email' && s.email ? `почта ${s.email}` : channelLabel(id))).join(', ');
export const describeSchedule =(s) => `${describeWhen(s)} · за ${periodWords(s.period)}`;

/** Одинаковое ли по смыслу другое расписание из списка (когда, период, срез, стратегии, разделы, куда) — тогда отчёт придёт дважды. */
export function findDuplicate(list, s) {
  const norm = (x) => JSON.stringify([
    x.frequency, x.frequency === 'weekly' ? x.dayOfWeek : x.frequency === 'monthly' ? x.dayOfMonth : x.date, x.hour, x.tz || MSK_TZ, x.period, x.scope,
    [...(x.strategies || [])].sort(), [...(x.sections || [])].sort(), [...(x.channels || [])].sort(), x.email || '',
  ]);
  const me = norm(s);
  return (list || []).find((x) => x.id !== s.id && norm(x) === me) || null;
}

/** Замечание, если период не подходит к частоте (например, каждую неделю отчёт «за прошлый год»). */
export function mismatchHint(s) {
  if (s.frequency === 'weekly' && ['last_month', 'last_quarter', 'last_year'].includes(s.period)) return 'Отчёты будут приходить каждую неделю, но за один и тот же прошлый период — они будут одинаковыми. Для еженедельной отправки обычно берут «Прошлая неделя».';
  if (s.frequency === 'monthly' && s.period === 'last_week') return 'Раз в месяц вы получите отчёт только за одну прошлую неделю. Для ежемесячной отправки обычно берут «Прошлый месяц».';
  return '';
}
