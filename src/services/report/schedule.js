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

/** Московские дата (YYYY-MM-DD), час, день недели (Пн=0) и число месяца для момента nowMs. */
export function mskParts(nowMs) {
  const d = new Date(nowMs + MSK_MS);
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
    channels: ['telegram'], email: '', sendNowAt: null,
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
  s.hour = HOURS.includes(raw.hour) ? raw.hour : 9;
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
  const p = mskParts(nowMs);
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
  const startDay = Math.floor((nowMs + MSK_MS) / 86400000); // номер московских суток
  for (let i = 0; i <= 400; i++) {
    const dayMs = (startDay + i) * 86400000 - MSK_MS;      // начало суток по Москве в UTC-мс
    const p = mskParts(dayMs + 3600000);
    if (!dueDay(s, p)) continue;
    const at = dayMs + s.hour * 3600000;
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

const hhmm = (h) => `${h}:00`;
export function describeWhen(s) {
  if (s.frequency === 'weekly') return `${EVERY[s.dayOfWeek]} ${WEEKDAYS[s.dayOfWeek]} в ${hhmm(s.hour)}`;
  if (s.frequency === 'monthly') return s.dayOfMonth === 'last' ? `В последний день каждого месяца в ${hhmm(s.hour)}` : `Каждый месяц, ${s.dayOfMonth}-го числа, в ${hhmm(s.hour)}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date || '');
  return m ? `Один раз: ${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1]} ${m[1]} в ${hhmm(s.hour)}` : 'Один раз (дата не выбрана)';
}
/** «Telegram, почта you@mail.ru» — куда уйдёт отчёт. */
export const describeChannels = (s) => (s.channels || ['telegram']).map((id) => (id === 'email' && s.email ? `почта ${s.email}` : channelLabel(id))).join(', ');
export const describeSchedule =(s) => `${describeWhen(s)} · за ${periodWords(s.period)}`;

/** Замечание, если период не подходит к частоте (например, каждую неделю отчёт «за прошлый год»). */
export function mismatchHint(s) {
  if (s.frequency === 'weekly' && ['last_month', 'last_quarter', 'last_year'].includes(s.period)) return 'Отчёты будут приходить каждую неделю, но за один и тот же прошлый период — они будут одинаковыми. Для еженедельной отправки обычно берут «Прошлая неделя».';
  if (s.frequency === 'monthly' && s.period === 'last_week') return 'Раз в месяц вы получите отчёт только за одну прошлую неделю. Для ежемесячной отправки обычно берут «Прошлый месяц».';
  return '';
}
