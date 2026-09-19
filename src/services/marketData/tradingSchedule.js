// src/services/marketData/tradingSchedule.js
//
// Расписание торгов Мосбиржи по типам инструментов — одно место на всё приложение.
//
// Зачем отдельный модуль. Раньше «торговые часы» были одной строкой в alerts.js: будни,
// 10:00-18:40 МСК, одинаково для всего. Из-за этого робот уведомлений засыпал в 18:40 и
// всю вечернюю сессию не видел вообще — а по фьючерсам это живая половина торгового дня.
// Плюс он ничего не знал про клиринг: в эти минуты торгов нет, а последняя цена висит
// старая, и любой расчёт по ней врёт.
//
// ⚠️ ЦИФРЫ НИЖЕ — ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ЗАДАНО РАСПИСАНИЕ. Биржа меняет его редко, но
// меняет; если время сессии или клиринга разъехалось с реальностью — правится только эта
// таблица, вся остальная логика от неё не зависит.
//
// Чего здесь СОЗНАТЕЛЬНО нет: календаря будних ПРАЗДНИКОВ. Его Мосбиржа публикует на год
// вперёд и он каждый год свой — зашитый список молча протухнет и будет врать хуже, чем
// его отсутствие. В праздник расписание считает день рабочим; для робота это значит лишь
// лишний холостой проход, а не неверное решение (свечей за этот день всё равно не будет).
//
// Единственное исключение — список выходных, в которые биржа НЕ торгует в 2026 году
// (WEEKEND_NO_TRADING_2026 ниже): там ошибка в «не ту» сторону стоила бы дороже. Раньше все
// выходные считались закрытыми, а с 2026 года почти все они торговые — и робот молчал.

// Всё расписание задаётся в московском времени, а сравнивается в UTC — так оно не зависит
// ни от часового пояса сервера (GitHub Actions живёт в UTC), ни от пояса браузера.
const MSK_OFFSET_MINUTES = 3 * 60;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Минута суток по московскому времени для любой даты.
function mskMinuteOfDay(date) {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMinutes + MSK_OFFSET_MINUTES) % (24 * 60);
}

// День недели по МОСКОВСКОМУ времени: в вечернюю сессию UTC-дата ещё та же, но около
// полуночи МСК они расходятся, и выходные определялись бы не по тому дню.
function mskDayOfWeek(date) {
  const shifted = new Date(date.getTime() + MSK_OFFSET_MINUTES * 60 * 1000);
  return shifted.getUTCDay(); // 0 — воскресенье, 6 — суббота
}

// Выходные, в которые Мосбиржа в 2026 году НЕ торгует. Во все остальные субботы и
// воскресенья действует сессия выходного дня (см. `weekend` в таблице ниже). Источник —
// официальное расписание Мосбиржи на 2026 год (moex.com/n95564), сверено со вторым
// источником (Mail.ru Финансы) 2026-09-19.
//
// ⚠️ Список ГОДОВОЙ: на 2027-й его надо заменить новым перечнем от биржи. Забыть это
// не страшно и не опасно — на дату без записи выходной считается торговым, то есть
// худший исход лишний холостой проход робота (свечей за такой день нет), а не пропущенный
// сигнал. Обратная ошибка (считать торговый выходной закрытым, как было раньше — весь
// выходной без единой проверки) обходится дороже, поэтому по умолчанию «торгуется».
const WEEKEND_NO_TRADING_2026 = new Set([
  '2026-01-03', '2026-01-04', '2026-01-10', '2026-01-11',
  '2026-02-14', '2026-02-15',
  '2026-03-07', '2026-03-08', '2026-03-21', '2026-03-22',
  '2026-05-09', '2026-05-10',
  '2026-06-20', '2026-06-21',
  '2026-08-01', '2026-08-02', '2026-08-15', '2026-08-16',
  '2026-09-12', '2026-09-13',
  '2026-10-24', '2026-10-25',
  '2026-12-05', '2026-12-06',
]);

// Календарная дата по МОСКОВСКОМУ времени (YYYY-MM-DD) — ту же поправку на пояс, что и в
// mskDayOfWeek: около полуночи UTC-дата и московская расходятся.
function mskDateString(date) {
  return new Date(date.getTime() + MSK_OFFSET_MINUTES * 60 * 1000).toISOString().slice(0, 10);
}

const SCHEDULES = {
  stock: {
    label: 'Акции',
    sessions: [
      { key: 'morning', label: 'утренняя сессия', from: '06:50', to: '09:50' },
      { key: 'main', label: 'основная сессия', from: '10:00', to: '18:40' },
      { key: 'evening', label: 'вечерняя сессия', from: '19:00', to: '23:50' },
    ],
    // Сессия выходного дня: суббота и воскресенье, 09:50–19:00 МСК, «дополнительная сессия»
    // следующего торгового дня. Акции из перечня биржи торгуются, но не все.
    weekend: { label: 'сессия выходного дня', from: '09:50', to: '19:00' },
    clearing: [],
  },
  future: {
    label: 'Фьючерсы',
    // С 23 марта 2026 торги фьючерсами идут БЕЗ остановок на клиринг в течение дня
    // (подтверждено поддержкой Т-Банка). Старые перерывы 14:00-14:05 и 18:50-19:05
    // больше не существуют — если робот будет считать их нерабочими, он молча
    // пропустит живые торги.
    //
    // Граница 19:00 оставлена не как перерыв, а как деление основной и вечерней сессий:
    // именно в 19:00 определяется расчётная цена за торговую сессию, и именно вечернюю
    // сессию трейдер может захотеть выключить в Настройках.
    sessions: [
      { key: 'morning', label: 'утренняя сессия', from: '07:00', to: '09:50' },
      { key: 'main', label: 'основная сессия', from: '10:00', to: '19:00' },
      { key: 'evening', label: 'вечерняя сессия', from: '19:00', to: '23:50' },
    ],
    // Фьючерсы и опционы в выходные торгуются в том же окне, что и акции.
    weekend: { label: 'сессия выходного дня', from: '09:50', to: '19:00' },
    // Единственный клиринг в сутки, переходит через полночь. В эти минуты торгов нет,
    // а вариационная маржа по фьючерсам как раз начисляется или списывается.
    clearing: [
      { label: 'клиринг', from: '23:50', to: '00:30' },
    ],
  },
  currency: {
    label: 'Валюта',
    sessions: [
      { key: 'main', label: 'основная сессия', from: '10:00', to: '23:50' },
    ],
    clearing: [],
  },
};

export function scheduleFor(instrumentType) {
  return SCHEDULES[instrumentType] || SCHEDULES.stock;
}

/** Человеческое описание расписания — для подсказок в интерфейсе. */
export function describeSchedule(instrumentType) {
  const s = scheduleFor(instrumentType);
  const days = s.sessions.map((x) => `${x.label} ${x.from}–${x.to}`).join(', ');
  return s.weekend ? `${days}; в выходные — ${s.weekend.label} ${s.weekend.from}–${s.weekend.to}` : days;
}

function inWindow(minute, from, to) {
  const a = toMinutes(from);
  const b = toMinutes(to);
  if (a <= b) return minute >= a && minute < b;
  // Окно переходит через полночь (клиринг по фьючерсам 23:50-00:30) — это не одна
  // непрерывная полоса минут, а две: «после начала» и «до конца уже следующих суток».
  return minute >= a || minute < b;
}

/**
 * В какой фазе рынок прямо сейчас.
 *
 * @param {string} instrumentType - 'stock' | 'future' | 'currency'
 * @param {Date}   [date]
 * @returns {{open: boolean, phase: string, label: string, sessionKey: string|null}}
 *   phase: 'morning' | 'main' | 'evening' — идут торги
 *          'clearing' — перерыв на клиринг (торгов нет, цена стоит)
 *          'weekend' | 'closed' — торгов нет
 */
export function marketPhase(instrumentType, date = new Date()) {
  const day = mskDayOfWeek(date);
  const s = scheduleFor(instrumentType);
  const minute = mskMinuteOfDay(date);
  if (day === 0 || day === 6) {
    // Раньше здесь было безусловное «выходной — биржа закрыта». С 2026 года Мосбиржа
    // торгует акциями и срочным рынком почти во все субботы и воскресенья, из-за чего
    // робот молчал весь выходной, хотя условия по инструментам сходились.
    if (!s.weekend) {
      return { open: false, phase: 'weekend', label: 'выходной — этот рынок закрыт', sessionKey: null };
    }
    if (WEEKEND_NO_TRADING_2026.has(mskDateString(date))) {
      return { open: false, phase: 'weekend', label: 'выходной — Мосбиржа в этот день не торгует', sessionKey: null };
    }
    if (inWindow(minute, s.weekend.from, s.weekend.to)) {
      return { open: true, phase: 'weekend', label: s.weekend.label, sessionKey: 'weekend' };
    }
    return { open: false, phase: 'weekend', label: 'выходной — вне сессии выходного дня', sessionKey: null };
  }

  // Клиринг проверяем ПЕРВЫМ: он лежит внутри торговой сессии, и если спросить про сессию
  // раньше, рынок будет выглядеть открытым в минуты, когда торгов физически нет.
  for (const c of s.clearing) {
    if (inWindow(minute, c.from, c.to)) {
      return { open: false, phase: 'clearing', label: `${c.label} — торги приостановлены`, sessionKey: null };
    }
  }
  for (const session of s.sessions) {
    if (inWindow(minute, session.from, session.to)) {
      return { open: true, phase: session.key, label: session.label, sessionKey: session.key };
    }
  }
  return { open: false, phase: 'closed', label: 'вне торговых часов', sessionKey: null };
}

// Какие сессии робот вообще смотрит. По умолчанию все доступные: пропущенная сессия —
// это пропущенные сигналы, а не экономия. Выключаются в Настройках (утро и вечер обычно
// шумные, и трейдер может захотеть тишины).
export const DEFAULT_SESSION_PREFS = {
  sessionMorning: true,
  sessionMain: true,
  sessionEvening: true,
  sessionWeekend: true,
};

const PREF_BY_SESSION = {
  morning: 'sessionMorning',
  main: 'sessionMain',
  evening: 'sessionEvening',
  weekend: 'sessionWeekend',
};

/**
 * Should the robot be working right now for this instrument.
 * Учитывает и расписание биржи, и выбранные трейдером сессии.
 */
export function shouldWatchNow(instrumentType, prefs = DEFAULT_SESSION_PREFS, date = new Date()) {
  const phase = marketPhase(instrumentType, date);
  if (!phase.open) return false;
  const prefKey = PREF_BY_SESSION[phase.sessionKey];
  if (!prefKey) return true;
  return (prefs?.[prefKey] ?? DEFAULT_SESSION_PREFS[prefKey]) !== false;
}

/**
 * Открыт ли хоть один рынок — этим роботу решать, просыпаться ли вообще на этом проходе.
 * Проверяет все типы инструментов, потому что у фьючерсов и акций сессии не совпадают.
 */
export function anyMarketOpen(prefs = DEFAULT_SESSION_PREFS, date = new Date()) {
  return Object.keys(SCHEDULES).some((type) => shouldWatchNow(type, prefs, date));
}
