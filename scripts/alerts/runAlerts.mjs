// scripts/alerts/runAlerts.mjs
//
// Фоновый проверяльщик: читает открытые сделки из Firestore, тянет свежие свечи,
// прогоняет их ТЕМ ЖЕ движком, что и бэктест, и шлёт события в Telegram.
// Запускается по расписанию из GitHub Actions (см. .github/workflows/traderpro-alerts.yml).
//
// Почему не Firebase Cloud Functions: на бесплатном тарифе Google запрещает функциям
// ходить в интернет за пределы своих сервисов, а Telegram — снаружи. Firestore при этом
// читается снаружи без ограничений, поэтому расписание живёт где угодно. Сегодня это
// GitHub Actions; при переезде на российский сервер меняется только этот файл и workflow,
// а вся логика (alerts.js, livePosition.js, engine.js) остаётся нетронутой.
//
// Переменные окружения (задаются в Secrets репозитория):
//   FIREBASE_SERVICE_ACCOUNT  - JSON сервисного аккаунта Firebase, одной строкой
//   TELEGRAM_BOT_TOKEN        - токен бота от @BotFather
//   TELEGRAM_CHAT_ID          - твой chat id (см. инструкцию в README рядом)
//   ALERT_UIDS                - через запятую: uid пользователей, чьи сделки проверять
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// --- Загрузка исходников приложения в Node -------------------------------------------
// В src/ лежит браузерный код: относительные импорты без расширений и импорт tinkoff.js,
// который в Node не нужен. Тот же приём, что во всех исследовательских скриптах: копируем
// во временную папку, дописываем расширения, подменяем ненужный модуль заглушкой.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-alerts-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy', 'exitRules']) {
  esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
  ["from '../analytics/", "from './"], ["from '../../utils/calculator.js'", "from './calculator.js'"],
]);
const liveUrl = esmify(path.join(repoRoot, 'src/services/backtest/livePosition.js'), [["from './engine'", "from './engine.js'"]]);
const alertsUrl = esmify(path.join(repoRoot, 'src/services/alerts.js'));
const candlesUrl = esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]);

const { computeLiveState } = await import(liveUrl);
const {
  evaluateAlerts, filterNew, formatForTelegram, isTradingHours, DEFAULT_ALERT_PREFS,
  buildKeyboard, buildReasonKeyboard, escapeHtml, SKIP_REASONS,
} = await import(alertsUrl);
const { fetchDailyCandles } = await import(candlesUrl);

// --- Firebase --------------------------------------------------------------------------
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return admin.firestore();
}

// --- Telegram ----------------------------------------------------------------------------
const TG = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Нет TELEGRAM_BOT_TOKEN');
  return `https://api.telegram.org/bot${token}`;
};

async function tg(method, body) {
  const res = await fetch(`${TG()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

async function sendTelegram(text, keyboard = null) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('Нет TELEGRAM_CHAT_ID');
  return tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

// --- Ответы на нажатия кнопок ---------------------------------------------------------
//
// Вебхука нет (для него нужен постоянно живущий адрес), поэтому нажатия забираем тем же
// расписанием: getUpdates с сохранённым offset. Задержка до 15 минут — для записи причины
// в дневник это не важно, Telegram подтверждает нажатие мгновенно на стороне телефона.
async function processCallbacks(db, uid, stateRef, state) {
  let updates;
  try {
    updates = await tg('getUpdates', { offset: state.offset || 0, timeout: 0, allowed_updates: ['callback_query'] });
  } catch (e) {
    console.error(`getUpdates: ${e.message}`);
    return;
  }
  if (!updates.length) return;

  for (const u of updates) {
    state.offset = u.update_id + 1;
    const cq = u.callback_query;
    if (!cq?.data?.startsWith('d|')) continue;

    const [, tradeId, code] = cq.data.split('|');
    const tradeRef = db.collection('trades').doc(tradeId);
    const trade = (await tradeRef.get()).data();
    const tag = trade ? `${trade.ticker}` : tradeId;
    let note = '';

    if (code === 'sn4') {
      state.snooze = state.snooze || {};
      state.snooze[tradeId] = Date.now() + 4 * 60 * 60 * 1000;
      note = 'Не буду дёргать по этой сделке 4 часа.';
      await tg('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    } else if (code === 'sk') {
      // Второй экран — за что именно пропустил.
      await tg('editMessageReplyMarkup', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        reply_markup: buildReasonKeyboard(tradeId),
      });
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Почему пропустил?' });
      continue;
    } else {
      const reason = SKIP_REASONS.find((r) => r.code === code);
      const action = code === 'fp' ? 'fixed_partial' : code === 'fa' ? 'closed_full' : 'skipped';
      const label = code === 'fp' ? 'Снял часть'
        : code === 'fa' ? 'Закрыл целиком'
          : (reason?.label || 'Ничего не делал');
      // Решение пишется в саму сделку — там же, где живёт её история, чтобы потом
      // «Сопровождение» могло показать, какие причины сколько стоили.
      await tradeRef.set({
        decisions: admin.firestore.FieldValue.arrayUnion({
          at: new Date().toISOString(), action, reason: reason?.label || null, via: 'telegram',
        }),
      }, { merge: true });
      note = action === 'skipped' ? `Записала причину: ${label.toLowerCase()}.` : `Записала: ${label.toLowerCase()}.`;
      await tg('editMessageText', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: `${cq.message.text ? escapeHtml(cq.message.text) : tag}\n\n<i>→ ${escapeHtml(label)}</i>`,
        parse_mode: 'HTML',
      });
    }

    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: note });
    console.log(`[${uid}] нажатие по ${tag}: ${code} — ${note}`);
  }
  await stateRef.set({ offset: state.offset, snooze: state.snooze || {} }, { merge: true });
}

// --- Основной проход -----------------------------------------------------------------
function tradeDirection(t) { return t.direction === 'short' ? 'short' : 'long'; }

// Индекс бара, ближайшего к дате входа и не позже неё.
function indexAtOrBefore(candles, date) {
  const target = new Date(date).getTime();
  let found = -1;
  for (let i = 0; i < candles.length; i++) {
    if (new Date(candles[i].date).getTime() <= target) found = i; else break;
  }
  return found;
}

async function checkTrade(db, uid, trade, prefs, sentMap) {
  const openedAt = trade.openDate || trade.openedAt || trade.entryDate;
  if (!openedAt || !trade.ticker || !trade.entryPrice) return [];

  const timeframe = trade.entryTimeframe || 'H1';
  const candles = await fetchDailyCandles({
    ticker: trade.ticker,
    instrumentType: trade.instrumentType || 'stock',
    toDate: new Date(),
    timeframe,
    lookbackDays: 120,
  });
  if (!candles?.length) return [];

  const entryIndex = indexAtOrBefore(candles, openedAt);
  if (entryIndex < 1 || entryIndex >= candles.length - 1) return [];

  const fills = (trade.legs || [])
    .filter((l) => l.type === 'close')
    .map((l) => ({
      index: Math.max(entryIndex + 1, indexAtOrBefore(candles, l.timestampUtc)),
      fraction: (parseFloat(l.quantity) || 0) / (parseFloat(trade.volume) || 1),
    }))
    .filter((f) => f.fraction > 0);

  const state = computeLiveState({
    candles,
    entryIndex,
    direction: tradeDirection(trade),
    entryPrice: parseFloat(trade.entryPrice),
    rules: prefs.exitRules || {},
    actualFills: fills,
    mode: 'actual',
  });

  const alerts = evaluateAlerts(state, { ...trade, id: trade.id }, prefs);
  const fresh = filterNew(alerts, sentMap);
  for (const a of fresh) {
    await sendTelegram(formatForTelegram(a), buildKeyboard(a, trade));
    sentMap[a.key] = Date.now();
    console.log(`[${uid}] отправлено: ${a.title}`);
  }
  if (!fresh.length) console.log(`[${uid}] ${trade.ticker}: без новых событий (score ${state.now?.profitScore})`);
  return fresh;
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force && !isTradingHours()) {
    console.log('Вне торговой сессии — проверять нечего.');
    return;
  }
  const db = initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');

  for (const uid of uids) {
    const profileSnap = await db.collection('users').doc(uid).get();
    const profile = profileSnap.data() || {};
    const strategy = (profile.strategies || []).find((s) => s.id === profile.activeStrategyId)
      || (profile.strategies || [])[0] || profile.strategy || {};
    const prefs = {
      ...DEFAULT_ALERT_PREFS,
      ...(profile.alertPrefs || {}),
      exitRules: strategy.exitRules || {},
    };

    // Отправленное храним в самой базе, иначе после каждого запуска раннера история
    // теряется и одни и те же события уходят снова и снова.
    const stateRef = db.collection('users').doc(uid).collection('alertState').doc('sent');
    const saved = (await stateRef.get()).data() || {};
    const sentMap = saved.keys || {};
    const runState = { offset: saved.offset || 0, snooze: saved.snooze || {} };

    // Сначала разбираем, что нажали с прошлого раза, — иначе «не дёргать 4 часа»
    // применится только со следующего запуска, и одно лишнее сообщение всё равно уйдёт.
    await processCallbacks(db, uid, stateRef, runState);

    const snap = await db.collection('trades')
      .where('userId', '==', uid)
      .where('status', 'in', ['open', 'partial'])
      .get();
    console.log(`[${uid}] открытых сделок: ${snap.size}`);

    for (const doc of snap.docs) {
      const trade = { id: doc.id, ...doc.data() };
      if ((runState.snooze[trade.id] || 0) > Date.now()) {
        console.log(`[${uid}] ${trade.ticker}: тихий режим до ${new Date(runState.snooze[trade.id]).toLocaleTimeString('ru-RU')}`);
        continue;
      }
      try {
        await checkTrade(db, uid, trade, prefs, sentMap);
      } catch (e) {
        console.error(`[${uid}] ${trade.ticker}: ${e.message}`);
      }
    }

    // Чистим просроченное, чтобы документ не рос бесконечно.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const k of Object.keys(sentMap)) if (sentMap[k] < cutoff) delete sentMap[k];
    for (const k of Object.keys(runState.snooze)) if (runState.snooze[k] < Date.now()) delete runState.snooze[k];
    await stateRef.set({
      keys: sentMap, offset: runState.offset, snooze: runState.snooze, updatedAt: Date.now(),
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
