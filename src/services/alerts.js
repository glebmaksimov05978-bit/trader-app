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
    ? `За последние ${state.momentum.bars} бара цена ${state.momentum.label} (${pct(state.momentum.changePct)}).`
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
  if (prefs[ALERT_TYPES.LOSS_SIGNAL] && now.lossScore != null && now.lossScore <= lossThreshold) {
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
    ],
  };
}

/** Второй экран: выбор причины после нажатия «Пропустил». */
export function buildReasonKeyboard(tradeId) {
  return {
    inline_keyboard: SKIP_REASONS.map((r) => ([{ text: r.label, callback_data: `d|${tradeId}|${r.code}` }])),
  };
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
  const reason = SKIP_REASONS.find((r) => r.code === code);
  return { action: 'skipped', label: reason?.label || 'Ничего не делал' };
}
