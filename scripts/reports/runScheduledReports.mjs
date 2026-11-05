// scripts/reports/runScheduledReports.mjs
//
// Отчёты по расписанию: для каждого пользователя из ALERT_UIDS смотрит расписания (users/<uid>.reportSchedules), собирает PDF
// за выбранный период и присылает файлом в Telegram. Запускается тем же заданием, что и остальные роботы (каждые 15 минут),
// поэтому «пора слать» определяется самим скриптом (services/report/schedule.js), а отметка «сегодня уже слали» хранится в
// профиле (users/<uid>.reportSendLog[id]) — три будильника отчёт не дублируют.
//
// Флаги: --dry — собрать PDF и показать, что ушло бы, но ничего не отправлять и не записывать (--out <папка> — сложить PDF туда);
//        --force — слать все включённые расписания независимо от дня и часа (для проверки).
// Модули приложения (src/…) нужны в виде ESM с расширениями .js — копируются во временную папку с сохранением структуры.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

/** Копия src-модулей и всего, что они импортируют по относительным путям, во временную папку (с добавленными .js). */
export function prepareModules(entries, { root = repoRoot } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-reports-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let text = fs.readFileSync(path.join(root, rel), 'utf8');
    text = text.replace(/(from\s+|import\s+)(['"])(\.\.?\/[^'"]+?)\2/g, (m, pre, q, spec) => {
      const hasExt = /\.[a-z]+$/i.test(spec);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      const real = hasExt ? target : (fs.existsSync(path.join(root, `${target}.js`)) ? `${target}.js` : `${target}/index.js`);
      if (!fs.existsSync(path.join(root, real))) return m; // упоминание пути в комментарии, а не импорт
      visit(real);
      return `${pre}${q}${hasExt ? spec : spec + (real.endsWith('/index.js') ? '/index.js' : '.js')}${q}`;
    });
    const out = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
  };
  entries.forEach(visit);
  return (rel) => pathToFileURL(path.join(tmp, rel)).href;
}

export async function loadModules() {
  const url = prepareModules([
    'src/services/report/exportReport.js', 'src/services/report/pdfDoc.js', 'src/services/report/schedule.js', 'src/services/analytics/insightsEngine.js',
  ]);
  const [exportReport, pdfDoc, schedule, insights, pdfNode] = await Promise.all([
    import(url('src/services/report/exportReport.js')), import(url('src/services/report/pdfDoc.js')), import(url('src/services/report/schedule.js')),
    import(url('src/services/analytics/insightsEngine.js')), import('./pdfNode.mjs'),
  ]);
  return { ...exportReport, ...schedule, buildPdfDefinition: pdfDoc.buildPdfDefinition, computeHabitsFor: insights.computeHabitsFor, renderPdfBuffer: pdfNode.renderPdfBuffer };
}

const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

/** Подпись под файлом в Telegram. */
export function reportCaption(model, schedule, M) {
  const s = model.stats;
  const head = `Отчёт: ${model.meta.period.title}`;
  const parts = [model.meta.scopeLabel];
  if (model.meta.strategies.length) parts.push(model.meta.strategiesText);
  if (model.empty) return `${head}\n${parts.join(' · ')}\nЗа период закрытых сделок не было.`;
  const tail = `${s.total} ${M.plural(s.total, ['сделка', 'сделки', 'сделок'])} · ${M.fmtMoney(s.pnl)} · ${M.fmtPct(s.winrate)} прибыльных`;
  return `${head}\n${parts.join(' · ')}\n${tail}${schedule.name ? `\n«${schedule.name}»` : ''}`.replace(/ /g, ' ');
}

/** Отправка файла в Telegram (multipart). */
export async function sendDocument({ token, chatId, filename, buffer, caption, apiBase = 'https://api.telegram.org', fetchImpl = fetch }) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 1000));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);
  const res = await fetchImpl(`${apiBase}/bot${token}/sendDocument`, { method: 'POST', body: form });
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (!data?.ok) return { ok: false, error: data?.description || `HTTP ${res.status}` };
  return { ok: true };
}

const MAX_TRIES_PER_DAY = 6;

/**
 * Один проход по пользователям. Всё внешнее передаётся снаружи, чтобы проверять тестом без базы и сети.
 * @param {{db, uids: string[], M: object, now?: number, dry?: boolean, force?: boolean, send: Function, outDir?: string, log?: Function}} a
 */
export async function runScheduledReports({ db, uids, M, now = Date.now(), dry = false, force = false, send, outDir = null, log = console.log }) {
  const results = [];
  for (const uid of uids) {
    const profileSnap = await db.collection('users').doc(uid).get();
    const profile = profileSnap.data() || {};
    const schedules = M.normalizeSchedules(profile.reportSchedules);
    const sendLog = profile.reportSendLog || {};
    const today = M.mskParts(now).date;
    const due = schedules.filter((s) => {
      const st = sendLog[s.id] || {};
      if (!force && (st.lastErrorDay === today && (st.tries || 0) >= MAX_TRIES_PER_DAY)) { log(`[${uid}] «${s.name || s.id}»: на сегодня исчерпаны попытки (${st.tries})`); return false; }
      const gate = force ? (s.enabled ? { send: true, reason: 'принудительно' } : { send: false, reason: 'выключено' }) : M.isScheduleDue(s, now, st);
      if (!gate.send) log(`[${uid}] «${s.name || s.id}»: ${gate.reason}`);
      return gate.send;
    });
    if (!due.length) continue;

    const [tSnap, pSnap] = await Promise.all([
      db.collection('trades').where('uid', '==', uid).get(),
      db.collection('paperTrades').where('uid', '==', uid).get(),
    ]);
    const realTrades = docs(tSnap), paperTrades = docs(pSnap);

    for (const s of due) {
      const period = M.resolvePeriod({ preset: s.period, now });
      const model = M.buildExportReport({
        realTrades, paperTrades, scope: s.scope, strategyNames: s.strategies, period, sections: s.sections,
        profile, habitsFn: M.computeHabitsFor, userName: profile.displayName || '', now,
      });
      const buffer = await M.renderPdfBuffer(M.buildPdfDefinition(model));
      const filename = M.reportFileName(model, 'pdf');
      const caption = reportCaption(model, s, M);
      if (dry) {
        if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, filename), buffer); }
        log(`[${uid}] «${s.name || s.id}» (сухо): ${filename}, ${Math.round(buffer.length / 1024)} КБ\n${caption}`);
        results.push({ uid, id: s.id, dry: true, filename, size: buffer.length });
        continue;
      }
      const r = await send({ filename, buffer, caption });
      const prev = sendLog[s.id] || {};
      if (r.ok) {
        log(`[${uid}] «${s.name || s.id}»: отправлен ${filename}`);
        await db.collection('users').doc(uid).set({ reportSendLog: { [s.id]: { lastSentOn: today, lastSentAt: now, lastTitle: model.meta.period.title, lastError: null, tries: 0, lastErrorDay: null } } }, { merge: true });
      } else {
        const tries = prev.lastErrorDay === today ? (prev.tries || 0) + 1 : 1;
        log(`[${uid}] «${s.name || s.id}»: НЕ отправлен — ${r.error} (попытка ${tries})`);
        await db.collection('users').doc(uid).set({ reportSendLog: { [s.id]: { ...prev, lastError: String(r.error).slice(0, 200), lastErrorDay: today, tries, lastTryAt: now } } }, { merge: true });
      }
      results.push({ uid, id: s.id, ok: !!r.ok, filename, size: buffer.length });
    }
  }
  return results;
}

async function main() {
  const DRY = process.argv.includes('--dry');
  const FORCE = process.argv.includes('--force');
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');
  const admin = (await import('firebase-admin')).default;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const M = await loadModules();
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  const send = async (a) => {
    if (!token || !chatId) return { ok: false, error: 'нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID' };
    return sendDocument({ token, chatId, apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org', ...a });
  };
  await runScheduledReports({ db, uids, M, dry: DRY, force: FORCE, send, outDir });
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main().catch((e) => { console.error(e); process.exit(1); });
