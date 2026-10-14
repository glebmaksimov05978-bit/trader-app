// src/services/alerts.js
//
// Логика уведомлений по открытым позициям. Намеренно чистая: на вход — состояние сделки,
// на выход — список событий. Ни сети, ни Firestore, ни браузера. Благодаря этому один и
// тот же код работает и в приложении (пока вкладка открыта), и в фоновом проверяльщике,
// который шлёт в Telegram, — второй реализации правил не будет.
//
// Порог уведомления НЕ равен порогу действия. Профит-система почти всегда пикует ровно
// на баре пика (медиана 0 баров от пика до срабатывания), поэтому сообщение «сигнал уже
// сработал» приходит, когда момент прошёл. Отсюда тип 'approaching': предупреждаем, когда
// до порога остался один признак.

export const ALERT_TYPES = {
  APPROACHING: 'approaching',   // до сигнала фиксации остался один признак
  PROFIT_FIRE: 'profit_fire',   // профит-система пробила порог
  LOSS_SIGNAL: 'loss_signal',   // лосс-система: дна не видно, позиция ухудшается
  GOAL_REACHED: 'goal_reached', // достигнута заданная цель по прибыли
  GIVEBACK: 'giveback',         // от пика отдано больше допустимого
};

export const DEFAULT_ALERT_PREFS = {
  [ALERT_TYPES.APPROACHING]: true,
  [ALERT_TYPES.PROFIT_FIRE]: true,
  [ALERT_TYPES.LOSS_SIGNAL]: true,
  [ALERT_TYPES.GOAL_REACHED]: false,
  [ALERT_TYPES.GIVEBACK]: false,
  goalPct: 5,          // цель по прибыли, %
  givebackPct: 50,     // сколько процентов пика можно отдать, прежде чем дёргать
  quietOutsideSession: true,
  // Какие сессии робот вообще смотрит. Само расписание сессий и клиринга живёт в
  // services/marketData/tradingSchedule.js — здесь только выбор трейдера. По умолчанию
  // все: пропущенная сессия означает пропущенные сигналы, а не экономию.
  sessionMorning: true,
  sessionMain: true,
  sessionEvening: true,
  sessionWeekend: true,
  // Бумажные сделки: открывать ли сигнал, на который по правилам риска не хватает денег.
  // По умолчанию выключено — робот ведёт себя как настоящая торговля и такой сигнал
  // пропускает. Включённый режим нужен для НАБЛЮДЕНИЯ: бумажная сделка денег не тратит,
  // и трейдеру важно видеть, сработала бы стратегия, даже если войти в неё он сейчас всё
  // равно не смог бы (дорогой инструмент + широкий стоп + небольшой депозит).
  paperIgnoreRiskSizing: false,
  // Слать ли в Telegram то, что делает робот с бумажными сделками. Отдельно от сигналов
  // по настоящим позициям: бумажных сделок со временем станет заметно больше, и они не
  // должны заглушать сообщения о реальных деньгах.
  paperTelegram: true,
  // Утренняя сводка в Telegram: что в рынке, что близко к входу, риск, итог вчерашнего дня.
  morningDigest: true,
  digestHour: 8,           // по Москве; шлётся при первом проходе робота после этого часа
  // Кнопки «Вошёл / Пропустил» под бумажными сигналами и сверка с позициями в Т-Банке.
  paperDecisionButtons: false, // включается после обновления бота в Telegram
  brokerActionSync: true,      // робот сам определяет ваши входы/выходы по позициям у брокера
};

// Здесь раньше была функция isTradingHours: будни, 10:00-18:40 МСК, одинаково для всех
// инструментов. Из-за неё робот засыпал в 18:40 и всю вечернюю сессию не видел вообще, а
// по фьючерсам это живая половина торгового дня; про клиринг она тоже ничего не знала.
// Расписание переехало в services/marketData/tradingSchedule.js, где оно задано по типам
// инструментов. Здесь оно СОЗНАТЕЛЬНО не импортируется: этот файл намеренно оставлен без
// единой зависимости (см. шапку) — именно поэтому его умеет запускать фоновый робот.

/**
 * Какие события порождает текущее состояние сделки.
 *
 * @param {object} state  - результат computeLiveState (livePosition.js)
 * @param {object} trade  - сделка из журнала (нужны ticker/direction для текста)
 * @param {object} prefs  - настройки пользователя, см. DEFAULT_ALERT_PREFS
 * @returns {Array<{type, key, title, body, severity}>}
 */
// «За последние 1 бара» — реальная жалоба со скриншота. Русский счётный падеж одной
// формой не зашьёшь: 1 бар, 2-4 бара, 5 и больше — баров.
function barsPhrase(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `последний ${n} бар`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `последние ${n} бара`;
  return `последние ${n} баров`;
}

export function evaluateAlerts(state, trade, prefs = DEFAULT_ALERT_PREFS) {
  if (!state?.now || !state.position) return [];
  const p = state.position;
  const now = state.now;
  const out = [];
  const tag = `${trade.ticker} ${trade.direction === 'short' ? 'шорт' : 'лонг'}`;
  const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  const profitThreshold = p.profitCaptureThreshold ?? 4;
  const lossThreshold = p.lossScoreThreshold ?? 2;

  // Какую долю система предлагает срезать на этом балле — берём ту же таблицу, по которой
  // движок режет в бэктесте, чтобы в уведомлении стояло реальное число, а не «часть».
  const shareFor = (score) => {
    const frac = p.profitCutByScore?.[score] ?? p.profitCutFraction ?? 1;
    return Math.round(frac * 100);
  };
  const inMarket = Math.round(state.remaining * 100);
  const moveLine = state.momentum
    ? `За ${barsPhrase(state.momentum.bars)} цена ${state.momentum.label} (${pct(state.momentum.changePct)}).`
    : '';
  const peakLine = state.peakPct > 0
    ? `Лучшее, что было по этой сделке: ${pct(state.peakPct)}, сейчас ${pct(now.returnPct)} — отдано ${state.givebackPct.toFixed(2)} пункта.`
    : `Сейчас ${pct(now.returnPct)}.`;

  if (prefs[ALERT_TYPES.PROFIT_FIRE] && now.profitScore >= profitThreshold) {
    const share = shareFor(now.profitScore);
    out.push({
      type: ALERT_TYPES.PROFIT_FIRE,
      key: `${trade.id}:${ALERT_TYPES.PROFIT_FIRE}:${now.profitScore}`,
      severity: 'action',
      suggestedShare: share,
      title: `${tag}: пора снять часть прибыли`,
      body: `${peakLine} ${moveLine}\n\n`
        + `Сошлось ${now.profitScore} признаков разворота из ${profitThreshold} нужных — по нашей истории `
        + `с этого места сделки чаще откатывались, чем росли дальше.\n\n`
        + `Система на твоём месте закрыла бы ${share}% позиции${share < 100 ? ' и оставила остальное в рынке' : ' целиком'}. `
        + `Сейчас открыто ${inMarket}% от изначального объёма. Решение за тобой.`,
    });
  } else if (prefs[ALERT_TYPES.APPROACHING] && now.profitScore === profitThreshold - 1) {
    out.push({
      type: ALERT_TYPES.APPROACHING,
      key: `${trade.id}:${ALERT_TYPES.APPROACHING}:${now.profitScore}`,
      severity: 'watch',
      title: `${tag}: подходит момент фиксации`,
      body: `${peakLine} ${moveLine}\n\n`
        + `Сошлось ${now.profitScore} признаков из ${profitThreshold} — не хватает одного. `
        + `Это ещё не сигнал, а предупреждение: успей посмотреть график, пока момент не прошёл.`,
    });
  }

  // Низкий near-bottom score = дна не видно, позиция продолжает ухудшаться.
  //
  // Порог шума — тот же, которым сам движок отделяет настоящее движение против позиции от
  // обычного колебания (engine.js: `-closeReturnPct >= position.trailMinPeakPct`). Без него
  // тревожное «падение похоже не закончилось» приходило на убытке в −0.04%, да ещё и рядом
  // со строкой «цена идёт в нашу сторону (+1.08%)» — реальная жалоба со скриншотом. Данные
  // там не противоречили друг другу (сделка чуть в минусе, а последний бар отскочил вверх),
  // но вместе это читалось как поломка. По сути это был крик волка на шуме: пока просадка
  // не вышла за шумовую единицу, никакого «падения» ещё нет.
  const lossBeyondNoise = p.trailMinPeakPct == null || -now.returnPct >= p.trailMinPeakPct;
  if (prefs[ALERT_TYPES.LOSS_SIGNAL] && now.lossScore != null && now.lossScore <= lossThreshold && lossBeyondNoise) {
    out.push({
      type: ALERT_TYPES.LOSS_SIGNAL,
      key: `${trade.id}:${ALERT_TYPES.LOSS_SIGNAL}:${now.lossScore}`,
      severity: 'danger',
      title: `${tag}: падение похоже не закончилось`,
      // Штраф «слишком рано» может увести реальный счёт ниже нуля — верно для сравнения с
      // порогом выше, но «−1 из 2» в тексте читается как поломка, а не как «сигналов нет
      // совсем, да ещё и рано». Текст показывает 0 как пол, а не отрицательное число.
      body: `Убыток ${pct(now.returnPct)}. ${moveLine}\n\n`
        + `Признаков того, что дно рядом, почти нет (${Math.max(0, now.lossScore)} из ${lossThreshold}): `
        + `нет ни капитуляции по RSI, ни выноса за край Боллинджера. `
        + `Исторически из такого состояния позиция чаще продолжала ухудшаться, чем разворачивалась.\n\n`
        + `Сейчас открыто ${inMarket}% от изначального объёма.`,
    });
  }

  if (prefs[ALERT_TYPES.GOAL_REACHED] && prefs.goalPct != null && now.returnPct >= prefs.goalPct) {
    out.push({
      type: ALERT_TYPES.GOAL_REACHED,
      key: `${trade.id}:${ALERT_TYPES.GOAL_REACHED}`,
      severity: 'action',
      title: `${tag}: цель ${pct(prefs.goalPct)} достигнута`,
      body: `Сейчас ${pct(now.returnPct)}, пик ${pct(state.peakPct)}.`,
    });
  }

  if (prefs[ALERT_TYPES.GIVEBACK] && state.peakPct > 0 && prefs.givebackPct != null) {
    const givenBackShare = (state.givebackPct / state.peakPct) * 100;
    if (givenBackShare >= prefs.givebackPct) {
      out.push({
        type: ALERT_TYPES.GIVEBACK,
        key: `${trade.id}:${ALERT_TYPES.GIVEBACK}`,
        severity: 'danger',
        title: `${tag}: отдано ${Math.round(givenBackShare)}% пика`,
        body: `Пик был ${pct(state.peakPct)}, сейчас ${pct(now.returnPct)}.`,
      });
    }
  }

  return out;
}

/**
 * Оставляет только те события, которых ещё не было. Уведомлять надо на ПЕРЕХОДЕ, а не
 * каждую проверку, пока состояние держится — иначе за день накопится сотня одинаковых
 * сообщений и уведомления просто отключат. Тот же приём уже используется в Радаре.
 *
 * @param {Array}  alerts - что породило текущее состояние
 * @param {object} sent   - карта key → timestamp, уже отправленное (переживает перезапуск)
 * @param {number} [cooldownMs] - через сколько можно повторить то же событие
 */
export function filterNew(alerts, sent = {}, cooldownMs = 4 * 60 * 60 * 1000) {
  const now = Date.now();
  return alerts.filter((a) => {
    const last = sent[a.key];
    return !last || now - last > cooldownMs;
  });
}

// Причины пропуска — те же, что показывает «Сопровождение» в лесенке фиксаций.
// Короткие коды нужны потому, что Telegram ограничивает данные кнопки 64 байтами.
export const SKIP_REASONS = [
  { code: 'r1', label: 'Жду уровень' },
  { code: 'r2', label: 'Новости' },
  { code: 'r3', label: 'Не успел' },
  { code: 'r4', label: 'Не поверил сигналу' },
  { code: 'r5', label: 'Держу до цели' },
];

// Markdown намеренно не используем: тикеры и проценты содержат символы, которые Telegram
// трактует как разметку, и сообщение молча не доставляется. HTML предсказуемее — надо лишь
// экранировать три символа.
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatForTelegram(alert) {
  const mark = alert.severity === 'danger' ? '🔴' : alert.severity === 'action' ? '🟡' : '⚪️';
  return `${mark} <b>${escapeHtml(alert.title)}</b>\n${escapeHtml(alert.body)}`;
}

/**
 * Сообщение о БУМАЖНОЙ сделке — намеренно отдельным видом от formatForTelegram.
 *
 * Причина не косметическая. У настоящей сделки под сообщением стоят кнопки («Снял часть»,
 * «Закрыл целиком»): они существуют, чтобы трейдер зафиксировал СВОЁ решение в момент,
 * когда его принял. У бумажной сделки решения человека нет вообще — её открывает, ведёт и
 * закрывает робот. Кнопка там записала бы в дневник причин решение, которого трейдер не
 * принимал, поэтому у бумажных сообщений кнопок нет ни одной (см. buildKeyboard — он
 * вызывается только для настоящих сделок).
 *
 * Отсюда же значок и слово «бумажная» прямо в первой строке: в общем потоке Telegram
 * должно быть видно с одного взгляда, где реальные деньги, а где наблюдение.
 */
export function formatPaperForTelegram({ title, lines = [], trade = null }) {
  // Стратегия и её таймфрейм — в самом заголовке: когда бумажно торгуют несколько стратегий
  // (краткосрок, среднесрок…), по одному взгляду должно быть видно, чья это лента.
  const strat = trade?.entryStrategyName
    ? ` · ${escapeHtml(trade.entryStrategyName)}${trade.entryTimeframe ? ` (${escapeHtml(trade.entryTimeframe)})` : ''}`
    : '';
  const head = `📄 <b>Бумажная${strat} — ${escapeHtml(title)}</b>`;
  const body = lines.filter(Boolean).map((l) => escapeHtml(l)).join('\n');
  // Ненавязчиво, отдельной строкой курсивом, а не отдельной тревогой: объём такой сделки
  // условный, и её результат нельзя принимать за достижимый на текущем депозите.
  const tail = trade?.riskTooBig
    ? '\n\n<i>Объём условный: на эту сделку при текущем депозите денег бы не хватило.</i>'
    : '';
  return `${head}${body ? `\n${body}` : ''}${tail}`;
}

/**
 * Кнопки под уведомлением. Смысл в том, чтобы решение фиксировалось В МОМЕНТ его принятия,
 * с телефона, а не заносилось потом по памяти — дневник причин иначе просто не наполнится.
 * Кнопки показываем только там, где есть что решать: на предупреждениях «за шаг до сигнала»
 * решать ещё нечего.
 */
export function buildKeyboard(alert, trade) {
  if (alert.type === ALERT_TYPES.APPROACHING) {
    return { inline_keyboard: [[{ text: '🔕 Не напоминать 4 часа', callback_data: `d|${trade.id}|sn4` }]] };
  }
  const share = alert.suggestedShare;
  return {
    inline_keyboard: [
      // Раньше кнопка называлась просто «Зафиксировал» — непонятно, часть или всё.
      // Теперь в самой кнопке стоит доля, которую предложила система.
      [{ text: share && share < 100 ? `✂️ Снял часть (${share}%)` : '✂️ Снял часть', callback_data: `d|${trade.id}|fp` }],
      [{ text: '🚪 Закрыл сделку целиком', callback_data: `d|${trade.id}|fa` }],
      [
        { text: '➡️ Ничего не делал', callback_data: `d|${trade.id}|sk` },
        { text: '🔕 Тихо 4 часа', callback_data: `d|${trade.id}|sn4` },
      ],
      // Закрыть по-настоящему, не уходя из Telegram. Нажатие ничего не отправляет брокеру:
      // бот проверит позицию у брокера и попросит подтвердить (tgTrade.js).
      [{ text: '📉 Закрыть у брокера', callback_data: `x|c|${trade.id}` }],
    ],
  };
}

/**
 * Слать ли в Telegram сообщение о бумажной сделке этой стратегии. Общий выключатель
 * paperTelegram + список заглушённых стратегий paperTelegramMuted (Настройки → Бумажные сделки):
 * когда торгуют сразу несколько стратегий, шумную можно приглушить, не трогая остальные.
 */
export function paperTelegramAllowed(prefs = {}, strategyId = null, strategies = null) {
  if (prefs.paperTelegram === false) return false;
  const muted = Array.isArray(prefs.paperTelegramMuted) ? prefs.paperTelegramMuted : [];
  if (strategyId && muted.includes(strategyId)) return false;
  // Режим наблюдения (Сопровождение): бумажные сделки идут, уведомлений нет.
  if (strategyId && Array.isArray(strategies)) {
    const st = strategies.find((s) => s && s.id === strategyId);
    if (st && st.observe === true) return false;
  }
  return true;
}

/**
 * Кнопка под сообщением «бумажная открыта»: повторить реальной заявкой. Это не «решение по
 * сигналу» (такие кнопки бумажным не нужны — их ведёт робот), а ДЕЙСТВИЕ трейдера: открыть
 * свою позицию. Само нажатие ничего не отправляет — бот сначала покажет подтверждение
 * (workers/telegram-webhook/src/tgTrade.js).
 */
export function paperRepeatKeyboard(paperId) {
  if (!paperId) return null;
  return { inline_keyboard: [[{ text: '🔁 Повторить реально', callback_data: `x|o|${paperId}` }]] };
}

// Причины пропуска БУМАЖНОГО сигнала — свои: «Держу до цели» здесь не имеет смысла (позиции нет).
export const PAPER_SKIP_REASONS = [
  { code: 'r1', label: 'Жду уровень' },
  { code: 'r2', label: 'Новости' },
  { code: 'r3', label: 'Не успел' },
  { code: 'r4', label: 'Не поверил сигналу' },
  { code: 'r6', label: 'Лимит риска исчерпан' },
  { code: 'r7', label: 'Не моя ситуация' },
];

// У решений по бумажным сделкам в идентификаторе стоит префикс «P:» — раннер по нему понимает,
// что писать надо в paperTrades, а не в trades.
export const PAPER_ID_PREFIX = 'P:';
export const isPaperRef = (id) => String(id || '').startsWith(PAPER_ID_PREFIX);
export const paperRef = (id) => `${PAPER_ID_PREFIX}${id}`;

/** Второй экран: выбор причины после нажатия «Пропустил». */
export function buildReasonKeyboard(tradeId) {
  const list = isPaperRef(tradeId) ? PAPER_SKIP_REASONS : SKIP_REASONS;
  return {
    inline_keyboard: list.map((r) => ([{ text: r.label, callback_data: `d|${tradeId}|${r.code}` }])),
  };
}

/**
 * Кнопки под сигналом бумажной сделки: что СДЕЛАЛИ ВЫ. Это не решение по сигналу робота (бумажную
 * сделку ведёт он сам), а отметка вашего действия — чтобы система знала, по каким сигналам вы
 * реально торговали, и сравнивала вас с собой честно.
 *
 * Показывается только когда включено в Настройках (alertPrefs.paperDecisionButtons): нажатия
 * разбирает воркер Telegram, и до его обновления новые коды он поймёт неверно.
 */
export function paperDecisionKeyboard(paperId, { repeat = true } = {}) {
  if (!paperId) return null;
  const ref = paperRef(paperId);
  const rows = [[
    { text: '✅ Вошёл', callback_data: `d|${ref}|en` },
    { text: '⏭ Пропустил', callback_data: `d|${ref}|sk` },
  ]];
  if (repeat) rows.push([{ text: '🔁 Повторить реально', callback_data: `x|o|${paperId}` }]);
  return { inline_keyboard: rows };
}

/** Клавиатура под вопросом «по какой стратегии вы вошли?» (неоднозначное определение по брокеру). */
export function ambiguousEntryKeyboard(candidates) {
  const rows = (candidates || []).slice(0, 4).map((c) => ([{
    text: `✅ «${String(c.strategy || 'без названия').slice(0, 28)}»`,
    callback_data: `d|${paperRef(c.paperId)}|en`,
  }]));
  const first = (candidates || [])[0];
  if (first) rows.push([{ text: '✖ Ни по одной', callback_data: `d|${paperRef(first.paperId)}|nt` }]);
  return { inline_keyboard: rows };
}

/** «Система увидела позицию — это не по этому сигналу?» */
export function notThisKeyboard(paperId) {
  if (!paperId) return null;
  return { inline_keyboard: [[{ text: '✖ Это не по этому сигналу', callback_data: `d|${paperRef(paperId)}|nt` }]] };
}

/**
 * Код кнопки → что это значит по-русски. Общая для Cloudflare Worker (мгновенный ответ
 * Telegram) и фонового раннера (запись в Firestore) — чтобы формулировки не разъехались
 * между «что увидел трейдер» и «что легло в дневник причин».
 */
export function describeDecision(code) {
  if (code === 'fp') return { action: 'fixed_partial', label: 'Снял часть' };
  if (code === 'fa') return { action: 'closed_full', label: 'Закрыл целиком' };
  if (code === 'sn4') return { action: 'snoozed', label: 'Тихий режим на 4 часа' };
  if (code === 'en') return { action: 'entered', label: 'Вошёл по сигналу' };
  if (code === 'nt') return { action: 'not_this', label: 'Это не по этому сигналу' };
  const reason = SKIP_REASONS.find((r) => r.code === code) || PAPER_SKIP_REASONS.find((r) => r.code === code);
  return { action: 'skipped', label: reason?.label || 'Ничего не делал' };
}

// ----------------------------------------------------------------------------------------------
// Карточка сигнала и утренняя сводка для Telegram
// ----------------------------------------------------------------------------------------------

const fmtNum = (v, d = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: d });
};
const fmtRubS = (v) => `${Math.round(Number(v) || 0).toLocaleString('ru-RU')} ₽`;
const fmtSigned = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${fmtNum(Math.abs(v), 1)}%`);

/**
 * Подробная карточка бумажного сигнала. Всё, что нужно, чтобы решить «вхожу / пропускаю» не открывая
 * приложение: стратегия и таймфрейм, вход/стоп/цель в рублях и процентах, соотношение прибыли к
 * риску, объём и риск в процентах депозита, какие условия стратегии сошлись, а какие нет.
 *
 * @param {object} a
 * @param {object} a.trade — бумажная сделка (ticker, direction, entryPrice, stopLoss, takeProfit, volume, entryStrategyName, entryTimeframe)
 * @param {string} [a.caption] — «краткосрок · Ч1»
 * @param {Array<{label:string, passed:boolean}>} [a.conditions]
 * @param {number|null} [a.riskRub]
 * @param {number|null} [a.riskPct] — % от капитала стратегии/депозита
 * @param {string|null} [a.signalBar] — дата свечи, на закрытии которой сошлись условия (строка)
 */
export function formatPaperSignalCard({ trade, caption = '', conditions = [], riskRub = null, riskPct = null, signalBar = null }) {
  const dir = trade.direction === 'short' ? 'шорт' : 'лонг';
  const strat = trade.entryStrategyName ? `«${escapeHtml(trade.entryStrategyName)}»` : 'стратегия без названия';
  const head = `📄 <b>Бумажная · ${strat} — ${escapeHtml(trade.ticker)} ${dir}, сигнал</b>`;
  const sub = [caption, signalBar ? `свеча ${signalBar}` : null].filter(Boolean).map(escapeHtml).join(' · ');

  const entry = Number(trade.entryPrice);
  const stop = trade.stopLoss != null ? Number(trade.stopLoss) : null;
  const take = trade.takeProfit != null ? Number(trade.takeProfit) : null;
  const sign = trade.direction === 'short' ? -1 : 1;
  const pctTo = (p) => (entry > 0 && p != null ? ((p - entry) / entry) * 100 * sign : null);

  const lines = [];
  const parts = [`<b>Вход</b> ${fmtNum(entry)}`];
  if (stop != null) parts.push(`<b>Стоп</b> ${fmtNum(stop)} (${fmtSigned(pctTo(stop))})`);
  else parts.push('<b>Стопа нет</b> — ведёт следящий выход');
  if (take != null) parts.push(`<b>Цель</b> ${fmtNum(take)} (${fmtSigned(pctTo(take))})`);
  lines.push(parts.join('  ·  '));

  if (stop != null && take != null && Math.abs(entry - stop) > 0) {
    lines.push(`Прибыль к риску: ${fmtNum(Math.abs(take - entry) / Math.abs(entry - stop), 1)} : 1`);
  }
  const vol = [`Объём ${fmtNum(trade.volume, 0)}`];
  if (riskRub != null) vol.push(`риск ≈ ${fmtRubS(riskRub)}${riskPct != null ? ` (${fmtNum(riskPct, 1)}% капитала)` : ''}`);
  lines.push(vol.join(' · '));

  const passed = conditions.filter((c) => c.passed).length;
  let cond = '';
  if (conditions.length) {
    cond = `\n\n<b>Условия стратегии: ${passed} из ${conditions.length}</b>\n`
      + conditions.slice(0, 10).map((c) => `${c.passed ? '✅' : '▫️'} ${escapeHtml(c.label)}`).join('\n');
  } else if (trade.entryPassed != null && trade.entryTotal != null) {
    cond = `\n\n<b>Условия стратегии: ${trade.entryPassed} из ${trade.entryTotal}</b>`;
  }

  const tail = trade.riskTooBig
    ? '\n\n<i>Объём условный: на эту сделку при текущем депозите денег бы не хватило.</i>'
    : '';
  return `${head}${sub ? `\n<i>${sub}</i>` : ''}\n\n${lines.join('\n')}${cond}${tail}`;
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * Утренняя сводка. Секции без содержимого не выводятся; если пусто всё — вернёт null (слать нечего).
 *
 * @param {object} a
 * @param {Date} a.date
 * @param {Array} a.open — открытые реальные: { ticker, direction, strategy, entryPrice, stopLoss, takeProfit, days }
 * @param {Array} a.paper — открытые бумажные: { ticker, direction, strategy, caption }
 * @param {Array} a.near — близко к входу: { ticker, strategy, passed, total }
 * @param {object|null} a.risk — { riskRub, riskPct, count }
 * @param {object|null} a.yesterday — { count, pnl }
 * @param {number} [a.pendingDecisions] — сколько бумажных сигналов ждут вашей отметки
 */
export function formatMorningDigest({ date, open = [], paper = [], near = [], risk = null, yesterday = null, pendingDecisions = 0 }) {
  const has = open.length || paper.length || near.length || (yesterday && yesterday.count) || pendingDecisions;
  if (!has) return null;
  const d = date instanceof Date ? date : new Date(date);
  const head = `☀️ <b>Утренняя сводка — ${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_G[d.getMonth()]}</b>`;
  const out = [head];
  const dirW = (x) => (x === 'short' ? 'шорт' : 'лонг');

  if (open.length) {
    out.push(`\n<b>В рынке (${open.length})</b>`);
    for (const t of open.slice(0, 8)) {
      const bits = [`вход ${fmtNum(t.entryPrice)}`];
      if (t.stopLoss != null) bits.push(`стоп ${fmtNum(t.stopLoss)}`);
      if (t.takeProfit != null) bits.push(`цель ${fmtNum(t.takeProfit)}`);
      if (t.days != null) bits.push(`${fmtNum(t.days, 0)} дн.`);
      out.push(`• ${escapeHtml(t.ticker)} ${dirW(t.direction)}${t.strategy ? ` · «${escapeHtml(t.strategy)}»` : ''} — ${bits.join(', ')}`);
    }
    if (open.length > 8) out.push(`… и ещё ${open.length - 8}`);
  }
  if (risk && risk.count) {
    out.push(`\n<b>Риск открытых позиций:</b> ${fmtRubS(risk.riskRub)}${risk.riskPct != null ? ` (${fmtNum(risk.riskPct, 1)}% депозита)` : ''}`);
  }
  if (paper.length) {
    out.push(`\n<b>Бумажные сделки (${paper.length})</b>`);
    for (const t of paper.slice(0, 8)) {
      out.push(`• ${escapeHtml(t.ticker)} ${dirW(t.direction)} · «${escapeHtml(t.strategy || 'без названия')}»${t.caption ? ` (${escapeHtml(t.caption)})` : ''}`);
    }
    if (paper.length > 8) out.push(`… и ещё ${paper.length - 8}`);
  }
  if (pendingDecisions > 0) {
    const word = pendingDecisions === 1 ? 'сигнал' : pendingDecisions < 5 ? 'сигнала' : 'сигналов';
    out.push(`\n<b>Ждут вашей отметки:</b> ${pendingDecisions} ${word} — вошли или пропустили (Сопровождение).`);
  }
  if (near.length) {
    out.push('\n<b>Близко к входу</b>');
    for (const n of near.slice(0, 6)) {
      out.push(`• ${escapeHtml(n.ticker)} — ${n.passed} из ${n.total} условий${n.strategy ? ` («${escapeHtml(n.strategy)}»)` : ''}`);
    }
  }
  if (yesterday && yesterday.count) {
    out.push(`\n<b>Вчера:</b> закрыто ${yesterday.count}, итог ${yesterday.pnl >= 0 ? '+' : '−'}${fmtRubS(Math.abs(yesterday.pnl))}`);
  }
  return out.join('\n');
}
