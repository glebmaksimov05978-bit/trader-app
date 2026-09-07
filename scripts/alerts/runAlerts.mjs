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
//   TELEGRAM_CHAT_ID          - твой chat id
//   ALERT_UIDS                - через запятую: uid пользователей, чьи сделки проверять
//   CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID
//                             - доступ к очереди решений от кнопок (см. workers/telegram-
//                               webhook/README.md). Не заданы — кнопки просто не разбираются,
//                               остальная рассылка работает как обычно.
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
  evaluateAlerts, filterNew, formatForTelegram, isTradingHours, DEFAULT_ALERT_PREFS, buildKeyboard,
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

// --- Разбор очереди решений от кнопок ---------------------------------------------------
//
// Кнопки под уведомлением обрабатывает отдельный Cloudflare Worker (workers/telegram-
// webhook) — он отвечает Telegram мгновенно, что и требуется, чтобы кнопка не крутилась
// вечно. Сюда воркер лишь кладёт решение в очередь (Cloudflare KV); здесь, раз в 15 минут,
// очередь разбирается и решения ложатся в Firestore — туда же, где остальная история сделки.
const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfKv(path, opts = {}) {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const ns = process.env.CF_KV_NAMESPACE_ID;
  if (!token || !account || !ns) return null; // Worker ещё не настроен — не ошибка, просто пропускаем
  const res = await fetch(`${CF_API}/accounts/${account}/storage/kv/namespaces/${ns}${path}`, {
    headers: { Authorization: `Bearer ${token}` }, ...opts,
  });
  if (!res.ok) throw new Error(`Cloudflare KV ${path}: ${res.status} ${await res.text()}`);
  return res;
}

async function applyPendingDecisions(db, uid, runState) {
  const listRes = await cfKv('/keys?limit=1000');
  if (!listRes) return; // секреты CF_* не заданы
  const { result: keys } = await listRes.json();
  if (!keys?.length) return;

  for (const { name } of keys) {
    try {
      const valueRes = await cfKv(`/values/${encodeURIComponent(name)}`);
      const entry = JSON.parse(await valueRes.text());
      const tag = entry.tradeId;

      if (entry.action === 'snoozed') {
        runState.snooze[entry.tradeId] = Date.now() + 4 * 60 * 60 * 1000;
      } else {
        // Решение пишется в саму сделку — там же, где живёт её история, чтобы потом
        // «Сопровождение» могло показать, какие причины сколько стоили.
        await db.collection('trades').doc(entry.tradeId).set({
          decisions: admin.firestore.FieldValue.arrayUnion({
            at: entry.at, action: entry.action, reason: entry.label, via: 'telegram',
          }),
        }, { merge: true });
      }
      await cfKv(`/values/${encodeURIComponent(name)}`, { method: 'DELETE' });
      console.log(`[${uid}] решение по ${tag}: ${entry.label}`);
    } catch (e) {
      console.error(`[${uid}] решение ${name}: ${e.message}`);
    }
  }
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
  const force = process.argv.includes('--force') || process.env.FORCE_CHECK === 'true';
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
    const runState = { snooze: saved.snooze || {} };

    // Сначала разбираем, что нажали с прошлого раза, — иначе «не дёргать 4 часа»
    // применится только со следующего запуска, и одно лишнее сообщение всё равно уйдёт.
    await applyPendingDecisions(db, uid, runState);

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
    await stateRef.set({ keys: sentMap, snooze: runState.snooze, updatedAt: Date.now() });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
