// scripts/radar/cleanupRadar.mjs
//
// Автоочистка радара: убирает мёртвые записи и заменяет истёкшие фьючерсы на «корень» (контракт
// сам переходит на новый). Решение принимает чистая функция planRadarCleanup
// (src/services/marketData/radarCleanup.js, с тестом) — здесь только сбор данных биржи, запись
// и сообщение в Telegram.
//
// Переменные окружения: FIREBASE_SERVICE_ACCOUNT, ALERT_UIDS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Флаг --dry — только показать, что было бы сделано. Отключается в профиле: alertPrefs.radarAutoCleanup = false.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const DRY = process.argv.includes('--dry');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-radarclean-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]);
esmify(path.join(repoRoot, 'src/services/marketData/futuresRoll.js'));
const { planRadarCleanup } = await import(esmify(path.join(repoRoot, 'src/services/marketData/radarCleanup.js')));

const ISS = 'https://iss.moex.com/iss';

async function issColumn(url, col) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MOEX ISS ${res.status}`);
  const json = await res.json();
  const cols = json.securities?.columns || [];
  const i = cols.indexOf(col);
  return (json.securities?.data || []).map((r) => String(r[i]));
}

// Статус акции, которой нет в списке торгов: торгуется где-то ещё (индекс, другая площадка) или мертва.
// Сбой запроса — «неизвестно» (не добавляем в карту): удалять по сетевой ошибке нельзя.
async function stockStatusOf(ticker) {
  try {
    const res = await fetch(`${ISS}/securities.json?q=${encodeURIComponent(ticker)}&iss.meta=off&iss.only=securities&securities.columns=secid,is_traded`);
    if (!res.ok) return null;
    const rows = (await res.json()).securities?.data || [];
    const exact = rows.find((r) => String(r[0]).toUpperCase() === ticker);
    if (exact && Number(exact[1]) === 1) return 'traded';
    return 'dead';
  } catch { return null; }
}

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true }); // см. комментарий в runPaperTrades.mjs
  return db;
}

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { console.error(`Telegram: ${e.message}`); }
}

async function main() {
  const db = initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');

  // Списки биржи грузим один раз на прогон; сбой любого — просто «нет надёжного списка», чистка пропускается.
  let stockSecids = null, futureSecids = null;
  try { stockSecids = new Set(await issColumn(`${ISS}/engines/stock/markets/shares/securities.json?iss.meta=off&iss.only=securities&securities.columns=SECID`, 'SECID')); } catch (e) { console.error(`список акций: ${e.message}`); }
  try { futureSecids = new Set(await issColumn(`${ISS}/engines/futures/markets/forts/securities.json?iss.meta=off&iss.only=securities&securities.columns=SECID`, 'SECID')); } catch (e) { console.error(`список фьючерсов: ${e.message}`); }

  for (const uid of uids) {
    const profile = (await db.collection('users').doc(uid).get()).data() || {};
    if (profile.alertPrefs?.radarAutoCleanup === false) { console.log(`[${uid}] автоочистка радара выключена`); continue; }

    const snap = await db.collection('radarItems').where('uid', '==', uid).get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Статус акций, которых нет в списке торгов, спрашиваем только для них — так лишних запросов почти нет.
    const stockStatus = new Map();
    if (stockSecids && stockSecids.size > 200) {
      for (const it of items) {
        const t = String(it.ticker || '').toUpperCase();
        if ((it.instrumentType || 'stock') === 'stock' && !stockSecids.has(t)) {
          const st = await stockStatusOf(t);
          if (st) stockStatus.set(t, st);
        }
      }
    }

    const { actions, aborted } = planRadarCleanup(items, { stockSecids, futureSecids, stockStatus });
    if (aborted) { console.log(`[${uid}] ${aborted}`); continue; }
    if (!actions.length) { console.log(`[${uid}] радар в порядке (${items.length})`); continue; }

    for (const a of actions) {
      console.log(`[${uid}] ${DRY ? 'сделал бы' : 'делаю'}: ${a.reason}`);
      if (DRY) continue;
      try {
        if (a.action === 'replace') {
          await db.collection('radarItems').doc(a.id).update({ ticker: a.to, replacedFrom: a.ticker, robotCheck: null });
        } else {
          await db.collection('radarItems').doc(a.id).delete();
        }
      } catch (e) { console.error(`[${uid}] ${a.ticker}: ${e.message}`); }
    }
    if (!DRY) {
      await notify(`🧹 <b>Радар почищен</b>\n${actions.map((a) => `• ${a.reason}`).join('\n')}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(0); }); // чистка вторична — её сбой не должен валить прогон
