// scripts/futures/syncMargins.mjs
//
// Робот «ГО и параметры фьючерсов»: раз в час подтягивает свежее ГО (и цену, шаг цены, лот, сбор, экспирацию) по тем фьючерсам, которые
// есть в радаре и в открытых позициях, сравнивает с прошлым часом и пишет в Telegram, если ГО (а значит и плечо) изменилось,
// контракт у «корня» сменился или у открытой позиции близка экспирация. Состояние кладёт в базу (futuresMargin/<uid>) — оттуда
// его читает приложение и показывает ГО/плечо в строках радара.
//
// Решения принимает чистый модуль src/services/marketData/marginTrack.js (с тестами: npm run test:margin) — здесь только ввод-вывод.
//
// Источники: биржа (ISS, без токена, один запрос на все фьючерсы). Если заданы RELAY_URL и RELAY_KEY — ещё и ГО Т-Банка отдельно для
// лонга и шорта (через российского посредника, только чтение): оно ближе к тому, что потребует брокер при заявке.
//
// Нагрузка на бесплатную базу: 1 чтение состояния за проход (на свежем — выход), раз в час — ещё чтение профиля, радара и открытых
// позиций и 1 запись. Настройки — в профиле: alertPrefs.marginNotifyRadar / marginNotifyOpen / marginNotifyPct (Настройки → «Фьючерсы: ГО и плечо»).
//
// Окружение: FIREBASE_SERVICE_ACCOUNT, ALERT_UIDS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, (необязательно) RELAY_URL, RELAY_URL_BACKUP, RELAY_KEY.
// Флаги: --dry — только показать; --force — не ждать часа с прошлого прохода.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { failWith } from '../lib/quota.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const MIN_INTERVAL_MS = 50 * 60 * 1000; // ГО у биржи меняется на клиринге (дважды в сутки), чаще часа смотреть незачем
const MAX_BROKER_CALLS = 25;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-margin-'));
const copied = path.join(tmp, 'marginTrack.js');
fs.copyFileSync(path.join(repoRoot, 'src/services/marketData/marginTrack.js'), copied);
const M = await import(pathToFileURL(copied).href);

async function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  const admin = (await import('firebase-admin')).default; // подгружается здесь, чтобы тест работал и без этого пакета
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

async function loadTable() {
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      const res = await fetch(M.FORTS_URL, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`MOEX ISS ${res.status}`);
      const table = M.parseFortsTable(await res.json());
      if (table.size < 50) throw new Error(`таблица фьючерсов пуста (${table.size})`);
      return table;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}

// ГО Т-Банка по каждому контракту (отдельно покупка и продажа). Нет посредника или он не ответил — контракта в карте не будет (останется биржевое).
async function loadBrokerMargins(secids) {
  const out = new Map();
  if (!process.env.RELAY_URL || !process.env.RELAY_KEY || !secids.length) return out;
  let tinkoff, parse;
  try {
    ({ tinkoff } = await import(pathToFileURL(path.join(repoRoot, 'workers/telegram-webhook/src/orders.js')).href));
    const bm = path.join(tmp, 'brokerMargin.js');
    fs.copyFileSync(path.join(repoRoot, 'src/services/marketData/brokerMargin.js'), bm);
    ({ parseBrokerFutureMargin: parse } = await import(pathToFileURL(bm).href));
  } catch (e) { console.error(`посредник Т-Банка недоступен: ${e.message}`); return out; }
  const env = { RELAY_URL: process.env.RELAY_URL, RELAY_URL_BACKUP: process.env.RELAY_URL_BACKUP, RELAY_KEY: process.env.RELAY_KEY };
  for (const secid of secids.slice(0, MAX_BROKER_CALLS)) {
    try {
      const data = await tinkoff(env, 'InstrumentsService/FutureBy', { idType: 'INSTRUMENT_ID_TYPE_TICKER', classCode: 'SPBFUT', id: secid });
      let res = parse(data?.instrument);
      if (!res && (data?.instrument?.uid || data?.instrument?.figi)) {
        try { res = parse(await tinkoff(env, 'InstrumentsService/GetFuturesMargin', { instrumentId: data.instrument.uid || data.instrument.figi })); }
        catch (e2) { console.error(`GetFuturesMargin по ${secid} недоступен: ${e2.message}`); }
      }
      if (res) out.set(secid, { buy: res.initialMarginBuy, sell: res.initialMarginSell });
    } catch (e) { console.error(`ГО Т-Банка по ${secid} не получено: ${e.message}`); }
  }
  return out;
}

async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return true; // слать некуда — состояние всё равно сохраняем
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (!data.ok) { console.error(`Telegram: ${data.description || res.status}`); return false; }
    return true;
  } catch (e) { console.error(`Telegram: ${e.message}`); return false; }
}

const mskDate = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);

/**
 * Один проход для каждого пользователя. Всё внешнее (база, биржа, брокер, Telegram, часы) передаётся снаружи — так проход проверяется тестом
 * на подставных данных (scripts/futuresMarginRunTests.mjs).
 */
export async function runMargins({ db, uids, loadTable: getTable = loadTable, brokerMargins = loadBrokerMargins, send: sendMsg = send, now = Date.now(), force = false, dry = false, log = console.log, errLog = console.error }) {
  let table = null;
  const results = [];
  for (const uid of uids) {
    const stateRef = db.collection('futuresMargin').doc(uid);
    const prev = (await stateRef.get()).data() || null;
    if (!force && prev?.at && now - Date.parse(prev.at) < MIN_INTERVAL_MS) {
      log(`[${uid}] ГО смотрели ${Math.round((now - Date.parse(prev.at)) / 60000)} мин назад — пропуск`);
      results.push({ uid, skipped: 'свежее' });
      continue;
    }

    const profile = (await db.collection('users').doc(uid).get()).data() || {};
    const prefs = M.marginPrefsOf(profile.alertPrefs);

    const [radarSnap, openSnap, paperSnap] = await Promise.all([
      db.collection('radarItems').where('uid', '==', uid).get(),
      db.collection('trades').where('uid', '==', uid).where('status', 'in', ['open', 'partial']).get(),
      db.collection('paperTrades').where('uid', '==', uid).where('status', 'in', ['open', 'partial']).get(),
    ]);
    const wanted = [];
    const add = (snap, scope) => snap.docs.forEach((d) => {
      const t = d.data();
      if (t.instrumentType === 'future' && t.ticker) wanted.push({ ticker: String(t.ticker), scope });
    });
    add(radarSnap, 'radar'); add(paperSnap, 'radar'); add(openSnap, 'open');
    if (!wanted.length) { log(`[${uid}] фьючерсов в радаре и позициях нет`); results.push({ uid, skipped: 'нет фьючерсов' }); continue; }

    table = table || await getTable();
    const secids = [...new Set(wanted.map((w) => M.resolveContract(table, w.ticker, new Date(now))?.row.secid).filter(Boolean))];
    const tbank = await brokerMargins(secids);

    const plan = M.planMarginRun({ prev, wanted, table, tbank, prefs, now: new Date(now), today: mskDate(now) });
    log(`[${uid}] контрактов ${Object.keys(plan.state.items).length}, источник ${tbank.size ? 'Т-Банк + биржа' : 'биржа'}; изменений ГО ${plan.changes.length}, смен контракта ${plan.rolls.length}, экспираций ${plan.expiring.length}${plan.missing.length ? `, не найдены: ${plan.missing.join(', ')}` : ''}`);

    // Первый проход (нет прошлого состояния) только запоминает: сравнивать не с чем, сообщений не будет.
    const text = M.formatMarginMessage(plan);
    let sent = false;
    if (text) {
      log(`[${uid}] сообщение:
${text}`);
      if (!dry) {
        sent = await sendMsg(text);
        if (!sent) { errLog(`[${uid}] сообщение не ушло — состояние не сохраняю, повторю на следующем проходе`); results.push({ uid, plan, sent: false, saved: false }); continue; }
      }
    }
    if (!dry) await stateRef.set({ uid, ...plan.state });
    results.push({ uid, plan, text, sent, saved: !dry });
  }
  return results;
}

async function main() {
  const db = await initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');
  await runMargins({ db, uids, force: FORCE, dry: DRY });
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main().catch((e) => failWith(e, 1));
