// yandex/robots/index.js
//
// Роботы TraderPro в Яндекс Облаке: одна функция, которую по таймеру будит триггер. Это тот же набор
// шагов, что сейчас делает GitHub Actions (.github/workflows/traderpro-alerts.yml), только запуск
// надёжный — по расписанию Яндекса, а не «когда получится» у GitHub. Сами скрипты НЕ переписаны: функция
// запускает те же файлы из scripts/ (они упакованы в архив рядом), так что поведение одинаковое.
//
// Режимы (переменная окружения ROBOTS_MODE):
//   diag  — ничего не делает, только проверяет, что из Яндекса видно: Firestore, Telegram, Cloudflare,
//           посредник к Т-Банку, MOEX; секреты не печатает. ПЕРВЫЙ запуск — всегда он.
//   dry   — все шаги в «сухом» режиме (--dry): считают и показывают, но ничего не пишут и не отправляют.
//   (пусто или live) — работа по-настоящему.
// Какие шаги и в каком порядке — ROBOTS_STEPS (через запятую), по умолчанию все.
//
// Ничего секретного здесь нет: ключи — в переменных окружения функции.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Корень с папкой scripts: в архиве функции это на уровень выше robots/, в репозитории — на два (yandex/robots/).
const root = [path.resolve(here, '..'), path.resolve(here, '../..')]
  .find((d) => fs.existsSync(path.join(d, 'scripts', 'alerts'))) || path.resolve(here, '..');

// Порядок как в workflow. Первым идёт утренняя сводка — она дешёвая.
export const STEPS = [
  { id: 'digest', script: 'scripts/alerts/morningDigest.mjs', dry: true },
  // Снимок для меню Telegram — рано: он дешёвый, а меню бота читает именно его («проверка была 11 часов назад»
  // — признак того, что до этого шага длинная цепочка не доходила).
  { id: 'snapshot', script: 'scripts/telegram/writeSnapshot.mjs', dry: true },
  { id: 'fills', script: 'scripts/telegram/applyFills.mjs', dry: true },
  { id: 'alerts', script: 'scripts/alerts/runAlerts.mjs', dry: false },
  { id: 'paper', script: 'scripts/paper/runPaperTrades.mjs', dry: true },
  { id: 'manage', script: 'scripts/paper/managePaperTrades.mjs', dry: true },
  { id: 'cleanup', script: 'scripts/radar/cleanupRadar.mjs', dry: true },
  { id: 'sync', script: 'scripts/paper/syncActions.mjs', dry: true },
];

const LIMIT_MS = 590 * 1000;     // у функции Яндекса максимум 10 минут; оставляем запас
const MIN_STEP_MS = 20 * 1000;   // если осталось меньше — шаг не начинаем (его сделает следующий запуск)

const tail = (s, n = 3000) => (s.length > n ? `…${s.slice(-n)}` : s);

function runStep(step, { dry, budgetMs }) {
  return new Promise((resolve) => {
    const args = [path.join(root, step.script)];
    if (dry && step.dry) args.push('--dry');
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: root, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\n[прервано по времени]'; child.kill('SIGKILL'); }, budgetMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ id: step.id, code, ms: Date.now() - started, out: tail(out) });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ id: step.id, code: -1, ms: Date.now() - started, out: String(e) }); });
  });
}

async function probe(name, fn) {
  const t = Date.now();
  try { return { name, ok: true, ms: Date.now() - t, note: await fn() }; }
  catch (e) { return { name, ok: false, ms: Date.now() - t, note: String(e.message || e).slice(0, 200) }; }
}

/** Что видно из Яндекса. Печатает только «да/нет» и коды ответов. */
export async function diagnose(env = process.env, fetchImpl = fetch) {
  const f = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) });
  const need = ['FIREBASE_SERVICE_ACCOUNT', 'ALERT_UIDS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'RELAY_URL', 'RELAY_KEY', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID'];
  const vars = Object.fromEntries(need.map((k) => [k, env[k] ? 'задана' : 'НЕ ЗАДАНА']));
  const tgBase = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const checks = await Promise.all([
    probe('Firestore (google)', async () => `код ${(await f('https://firestore.googleapis.com/')).status}`),
    probe('Telegram напрямую', async () => {
      if (!env.TELEGRAM_BOT_TOKEN) return 'нет токена';
      const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      return `код ${r.status}`;
    }),
    probe(`Telegram через ${env.TELEGRAM_API_BASE ? 'прокси воркера' : 'основной адрес'}`, async () => {
      if (!env.TELEGRAM_BOT_TOKEN) return 'нет токена';
      const r = await f(`${tgBase}/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      return `код ${r.status}`;
    }),
    probe('Cloudflare API', async () => {
      if (!env.CF_API_TOKEN) return 'нет токена';
      const r = await f('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
      return `код ${r.status}`;
    }),
    probe('Посредник к Т-Банку', async () => {
      if (!env.RELAY_URL) return 'нет адреса';
      const base = String(env.RELAY_URL).replace(/\/+$/, '');
      const url = /yandexcloud\.net/.test(base) ? `${base}?route=/health` : `${base}/health`;
      const r = await f(url);
      return `код ${r.status}`;
    }),
    probe('MOEX (свечи)', async () => `код ${(await f('https://iss.moex.com/iss/engines.json?iss.meta=off')).status}`),
  ]);
  return { time: new Date().toISOString(), node: process.version, vars, checks };
}

export async function handler(event) {
  const env = process.env;
  const mode = String(env.ROBOTS_MODE || (event && event.mode) || 'live').toLowerCase();
  if (mode === 'diag') {
    const d = await diagnose();
    console.log(JSON.stringify(d, null, 2));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) };
  }
  const dry = mode === 'dry';
  const wanted = String(env.ROBOTS_STEPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const steps = STEPS.filter((s) => (!wanted.length || wanted.includes(s.id)) && (!dry || s.dry));
  const started = Date.now();
  const report = [];
  for (const step of steps) {
    const left = LIMIT_MS - (Date.now() - started);
    if (left < MIN_STEP_MS) { report.push({ id: step.id, skipped: 'не хватило времени, сделает следующий запуск' }); continue; }
    const r = await runStep(step, { dry, budgetMs: left });
    console.log(`=== ${step.id}: код ${r.code}, ${Math.round(r.ms / 1000)} с ===\n${r.out}`);
    report.push({ id: r.id, code: r.code, sec: Math.round(r.ms / 1000) });
  }
  const body = { mode, totalSec: Math.round((Date.now() - started) / 1000), report };
  console.log(JSON.stringify(body));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
