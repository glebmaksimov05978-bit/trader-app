// Сторож будильников робота.
//
// Робота будят внешние будильники (Cloudflare, cron-job.org) — они запускают workflow через
// workflow_dispatch. Когда они молча умирают (истёк токен, задание выключили), остаётся только
// собственное расписание GitHub, которое срабатывает раз в несколько часов. Этот шаг смотрит
// список запусков и, если в торговое время давно не было ни одного запуска от будильников,
// пишет в Telegram. Повторно — не чаще раза в 3 часа (отметка лежит в Cloudflare KV).
//
// Окружение: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF (даёт сам GitHub),
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID.
// Флаг --dry: ничего не отправлять и не записывать, только показать вывод.

export const SILENCE_MIN = 60;      // сколько минут тишины считать поломкой
export const REPEAT_MIN = 180;      // как часто повторять предупреждение
const WINDOW_FROM = 8, WINDOW_TO = 22; // торговое время по Москве, часы [8; 22)

const mskHour = (date) => (date.getUTCHours() + 3) % 24;

// Чистая функция решения: слать ли предупреждение.
// runs — список запусков GitHub ({ event, created_at }), lastAlertAt — миллисекунды или null.
export function decide({ now, runs, lastAlertAt }) {
  const h = mskHour(now);
  if (h < WINDOW_FROM || h >= WINDOW_TO) return { alert: false, reason: 'вне торгового времени' };
  const alarms = (runs || []).filter((r) => r.event === 'workflow_dispatch').map((r) => Date.parse(r.created_at)).filter(Number.isFinite);
  const last = alarms.length ? Math.max(...alarms) : null;
  const silentMin = last == null ? null : Math.floor((now.getTime() - last) / 60000);
  if (silentMin != null && silentMin < SILENCE_MIN) return { alert: false, reason: 'будильники живы', silentMin };
  if (lastAlertAt != null && now.getTime() - lastAlertAt < REPEAT_MIN * 60000) return { alert: false, reason: 'недавно уже предупреждали', silentMin };
  return { alert: true, silentMin };
}

export function formatWatchdogMessage(silentMin) {
  const how = silentMin == null
    ? 'в последних запусках будильников нет вовсе'
    : silentMin >= 120 ? `последний был ${Math.floor(silentMin / 60)} ч назад` : `последний был ${silentMin} мин назад`;
  return [
    '<b>Будильники робота молчат</b>',
    `Идёт торговое время, но ${how}. Уведомления и сводка могут приходить с большим опозданием.`,
    '',
    'Проверить: cron-job.org (задание включено, в истории 200) и срок токена GITHUB_PAT в Cloudflare.',
  ].join('\n');
}

async function kv(method, key, body) {
  const token = process.env.CF_API_TOKEN, account = process.env.CF_ACCOUNT_ID, ns = process.env.CF_KV_NAMESPACE_ID;
  if (!token || !account || !ns) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}${method === 'PUT' ? '?expiration_ttl=86400' : ''}`;
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body });
  if (!res.ok) return null;
  return method === 'GET' ? res.text() : true;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const repo = process.env.GITHUB_REPOSITORY || 'glebmaksimov05978-bit/trader-app';
  const file = (process.env.GITHUB_WORKFLOW_REF || '').match(/workflows\/([^@]+)@/)?.[1] || 'traderpro-alerts.yml';
  const headers = { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=30`, { headers });
  if (!res.ok) { console.log('Список запусков не получен:', res.status); return; }
  const runs = (await res.json()).workflow_runs || [];

  const raw = await kv('GET', 'watchdog:last');
  const lastAlertAt = raw ? Number(raw) : null;
  const d = decide({ now: new Date(), runs, lastAlertAt: Number.isFinite(lastAlertAt) ? lastAlertAt : null });
  console.log('Сторож:', JSON.stringify(d));
  if (!d.alert) return;

  const text = formatWatchdogMessage(d.silentMin);
  if (dry) { console.log('[dry] отправил бы:\n' + text); return; }
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tg || !chat) { console.log('Нет токена или чата Telegram'); return; }
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${tg}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  console.log('Telegram:', r.status);
  if (r.ok) await kv('PUT', 'watchdog:last', String(Date.now()));
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main().catch((e) => { console.log('Сторож упал:', e.message); });
