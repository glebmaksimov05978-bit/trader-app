// scripts/paper/syncActions.mjs
//
// Робот отметок ваших действий: раз в проход смотрит позиции в Т-Банке (только чтение — через
// российский посредник) и сверяет их с открытыми бумажными сделками. Появилась позиция по тикеру
// бумажного сигнала — «вошёл»; уменьшилась — «снял часть»; пропала — «вышел». Так вам не нужно
// отмечать каждое действие вручную: журнал решений заполняется сам.
//
// Что делает и чего НЕ делает:
//   • только ЧИТАЕТ позиции (GetPositions) и пишет отметки в paperTrades/<id>.decisions и
//     paperTrades/<id>.brokerWatch; никаких заявок не отправляет — для заявок у него нет ни
//     кода, ни ключа;
//   • то, что определено автоматически, помечено via: 'broker' — это вывод системы, а не ваше
//     слово; под сообщением есть кнопка «Это не по этому сигналу»;
//   • позицию, которая уже учтена в Журнале, не дублирует (см. actionMatch.js).
//
// Переменные окружения (Secrets репозитория):
//   FIREBASE_SERVICE_ACCOUNT, ALERT_UIDS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — как у остальных роботов;
//   RELAY_URL, RELAY_KEY (необязательно RELAY_URL_BACKUP) — адрес и ключ российского посредника.
//   Без RELAY_URL/RELAY_KEY робот молча пропускает шаг: без доступа к брокеру определять нечего.
//
// Флаги: --dry — ничего не писать и не отправлять, только показать, что увидел.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-actions-'));
function esmify(src) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}

// Модули воркера (вызовы брокера через посредника) — стандартный ES-модуль, грузится как есть.
const ordersUrl = pathToFileURL(path.join(repoRoot, 'workers/telegram-webhook/src/orders.js')).href;
const tgTradeUrl = pathToFileURL(path.join(repoRoot, 'workers/telegram-webhook/src/tgTrade.js')).href;
const { tinkoff, listAccounts, resolveInstrument } = await import(ordersUrl);
const { heldBalance } = await import(tgTradeUrl);

const matchUrl = esmify(path.join(repoRoot, 'src/services/analytics/actionMatch.js'));
const alertsUrl = esmify(path.join(repoRoot, 'src/services/alerts.js'));
const { reconcileWithBroker, eventToDecision, describeEvent } = await import(matchUrl);
const { escapeHtml, ambiguousEntryKeyboard, notThisKeyboard } = await import(alertsUrl);

const DRY = process.argv.includes('--dry');

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

async function notify(text, keyboard = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram: ${data.description || res.status}`);
  } catch (e) {
    console.error(`Telegram: ${e.message}`);
  }
}

const brokerEnv = () => ({
  RELAY_URL: process.env.RELAY_URL,
  RELAY_URL_BACKUP: process.env.RELAY_URL_BACKUP,
  RELAY_KEY: process.env.RELAY_KEY,
});

/** ТИКЕР → суммарный баланс по всем счетам (со знаком). Тикеры, которых нет у брокера, пропускаются. */
export async function loadBalances(env, tickers) {
  const accounts = await listAccounts(env);
  const positions = [];
  for (const acc of accounts) {
    positions.push(await tinkoff(env, 'OperationsService/GetPositions', { accountId: acc.id }));
  }
  const out = {};
  for (const { ticker, type } of tickers) {
    let instrument = null;
    try { instrument = await resolveInstrument(env, ticker, type); } catch { /* тикер не найден — пропустим */ }
    if (!instrument) continue;
    out[ticker] = positions.reduce((s, pos) => s + heldBalance(pos, instrument), 0);
  }
  return out;
}

async function main() {
  if (!process.env.RELAY_URL || !process.env.RELAY_KEY) {
    console.log('Нет RELAY_URL/RELAY_KEY — сверка позиций с Т-Банком пропущена.');
    return;
  }
  const db = initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');
  const env = brokerEnv();

  for (const uid of uids) {
    const profile = (await db.collection('users').doc(uid).get()).data() || {};
    if (profile.alertPrefs?.brokerActionSync === false) { console.log(`[${uid}] сверка с брокером выключена в Настройках`); continue; }

    // Открытые бумажные + закрытые роботом, за которыми ещё следим («вы всё ещё в позиции»).
    const openSnap = await db.collection('paperTrades').where('uid', '==', uid).where('status', 'in', ['open', 'partial']).get();
    const watchSnap = await db.collection('paperTrades').where('uid', '==', uid).where('brokerWatch.state', '==', 'in').get();
    const byId = new Map();
    for (const d of [...openSnap.docs, ...watchSnap.docs]) byId.set(d.id, { id: d.id, ...d.data() });
    const paperTrades = [...byId.values()];
    if (!paperTrades.length) { console.log(`[${uid}] бумажных сделок для сверки нет`); continue; }

    const journalSnap = await db.collection('trades').where('uid', '==', uid).where('status', 'in', ['open', 'partial']).get();
    const journalTrades = journalSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const wanted = new Map();
    for (const p of paperTrades) {
      const t = String(p.ticker || '').toUpperCase();
      if (t && !wanted.has(t)) wanted.set(t, { ticker: t, type: p.instrumentType === 'future' ? 'future' : 'stock' });
    }

    let balances;
    try {
      balances = await loadBalances(env, [...wanted.values()]);
    } catch (e) {
      console.error(`[${uid}] не удалось получить позиции: ${e.message}`);
      continue;
    }

    const { events, patches } = reconcileWithBroker({ paperTrades, balances, journalTrades });
    console.log(`[${uid}] проверено ${paperTrades.length}, событий ${events.length}, изменений наблюдения ${Object.keys(patches).length}`);

    for (const [id, patch] of Object.entries(patches)) {
      if (DRY) continue;
      await db.collection('paperTrades').doc(id).update({
        brokerWatch: patch, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const alertsOn = profile.alertPrefs?.paperTelegram !== false;
    for (const ev of events) {
      const dec = eventToDecision(ev);
      // Неоднозначный вход в журнал решений не пишем — ждём, пока вы укажете стратегию.
      if (dec && !ev.ambiguous && !DRY) {
        await db.collection('paperTrades').doc(ev.paperId).update({
          decisions: admin.firestore.FieldValue.arrayUnion(dec),
        });
      }
      console.log(`[${uid}] ${DRY ? '(сухо) ' : ''}${describeEvent(ev)}`);
      if (DRY || !alertsOn) continue;
      const text = `🔎 ${escapeHtml(describeEvent(ev))}`;
      if (ev.ambiguous) {
        await notify(text, ambiguousEntryKeyboard(ev.candidates));
      } else if (profile.alertPrefs?.paperDecisionButtons === true && ev.kind === 'entered') {
        await notify(text, notThisKeyboard(ev.paperId));
      } else {
        await notify(text);
      }
    }
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main().catch((e) => { console.error(e); process.exit(1); });
