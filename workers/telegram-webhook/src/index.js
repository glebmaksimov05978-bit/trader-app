// workers/telegram-webhook/src/index.js
//
// Мгновенный ответ на нажатия кнопок под уведомлениями в Telegram.
//
// Почему это отдельный воркер, а не часть runAlerts.mjs: GitHub Actions проверяет позиции
// раз в 15 минут — этого достаточно, чтобы ПРИСЛАТЬ уведомление, но Telegram требует ответ
// на нажатие кнопки в течение ~15 секунд, иначе она вечно крутится у трейдера на экране.
// Значит нужен адрес, который отвечает мгновенно, а не по расписанию.
//
// Разделение обязанностей, чтобы не тащить сюда доступ к Firestore и логику движка:
//   1. Этот воркер мгновенно отвечает Telegram и кладёт решение в очередь (Cloudflare KV).
//   2. GitHub Actions при каждом проходе (раз в 15 минут) разбирает очередь и пишет решения
//      в Firestore — та же функция, что уже писала их напрямую, просто источник другой.
// Вся смысловая логика (что означает какая кнопка) — в src/services/alerts.js, один файл
// на приложение, воркер и раннер, чтобы формулировки не могли разойтись.
//
// Второй адрес того же воркера — отправка заявок брокеру (/order, см. orders.js).
// Почему в том же воркере, а не в отдельном: это личный воркер трейдера, и вторая
// установка означала бы второй деплой, второй набор секретов и второй источник
// расхождений. Обработчики при этом полностью раздельны — общего между ними ровно
// ничего, кроме адреса.
import { buildReasonKeyboard, describeDecision, escapeHtml } from '../../../src/services/alerts.js';
import { handleOrder, handleOrderConfig } from './orders.js';

// Репозиторий с роботом уведомлений/бумажных сделок — тот же, что и у этого воркера.
// Не секрет (это просто адрес открытого репозитория), поэтому можно хранить прямо тут.
const GITHUB_REPO = 'glebmaksimov05978-bit/trader-app';
const GITHUB_WORKFLOW = 'traderpro-alerts.yml';

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Собственно будильник — просит GitHub немедленно запустить робота (workflow_dispatch).
// Вызывается ДВУМЯ независимыми путями (см. ниже, почему их два): встроенным Cron
// Trigger'ом Cloudflare и обычным HTTP-запросом с внешнего крон-сервиса. Сам робот при
// этом не переехал: код и логика остаются в GitHub Actions — воркер только нажимает
// «запустить сейчас» по расписанию, которое реально соблюдается.
async function ringAlarm(env) {
  if (!env.GITHUB_PAT) {
    console.error('GITHUB_PAT не задан — будильник не может достучаться до GitHub');
    return { ok: false, reason: 'no-token' };
  }
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'traderpro-cron-worker',
      },
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    console.error(`Будильник: GitHub ответил ${res.status} ${text}`);
    return { ok: false, status: res.status, text };
  }
  return { ok: true };
}

export default {
  // Почему это здесь, а не просто в расписании самого GitHub Actions: собственное
  // расписание GitHub (`schedule: cron:`) — best-effort и НЕ гарантирует частоту. На
  // практике за 9 дней с cron "каждые 15 минут" реально сработало 16 раз вместо
  // ожидаемых нескольких сотен. Cloudflare Cron Triggers сначала решили эту проблему, но
  // и они сами оказались ненадёжны на практике (2026-09-19: срабатывает сразу после
  // переустановки сервера и затем сам замолкает на много часов — похоже на нестабильность
  // самого Cloudflare, у них в эти же дни были свои открытые инциденты по фоновым
  // процессам). Поэтому это уже не единственный будильник, а один из двух.
  async scheduled(event, env, ctx) {
    await ringAlarm(env);
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/order') return handleOrder(request, env);
    if (path === '/order/config') return handleOrderConfig(request, env);

    // Второй, независимый путь для будильника — обычный веб-адрес, на который может
    // стучаться внешний крон-сервис (cron-job.org и т.п.), а не встроенный механизм
    // Cloudflare. Так один и тот же адрес не зависит от надёжности ровно одной компании:
    // если подведёт Cloudflare Cron Trigger, сработает внешний сервис, и наоборот.
    // Лишние повторные запуски робота не опасны — сам робот безопасен для повторных
    // проходов (не откроет вторую бумажную сделку на тот же тикер, а на закрытой бирже
    // просто выходит с "рынки закрыты"), поэтому проверять точное время здесь не нужно.
    // TICK_SECRET в самом адресе — не защита денег (открывать реальные позиции этот путь
    // не может), а просто чтобы случайный бот в интернете не гонял наш workflow впустую.
    if (path === '/tick') {
      if (!env.TICK_SECRET || new URL(request.url).searchParams.get('key') !== env.TICK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const result = await ringAlarm(env);
      return new Response(result.ok ? 'ok' : `error: ${result.reason || result.status}`, {
        status: result.ok ? 200 : 502,
      });
    }

    // Всё остальное — вебхук Telegram: он ходит на корень адреса.
    if (request.method !== 'POST') return new Response('ok');

    // Секретный заголовок Telegram сам подставляет в каждый запрос на этот адрес —
    // отсекает чужие POST-запросы, которые кто-то отправит на угаданный URL воркера.
    if (env.WEBHOOK_SECRET) {
      const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (header !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    }

    const update = await request.json().catch(() => null);
    const cq = update?.callback_query;
    if (!cq?.data?.startsWith('d|')) return new Response('ok'); // не наша кнопка — молча выходим

    const [, tradeId, code] = cq.data.split('|');
    const token = env.BOT_TOKEN;

    // «Пропустил» — это не решение, а переход ко второму экрану с причинами.
    if (code === 'sk') {
      await tg(token, 'editMessageReplyMarkup', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        reply_markup: buildReasonKeyboard(tradeId),
      });
      await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Почему пропустил?' });
      return new Response('ok');
    }

    const { action, label } = describeDecision(code);

    // Кладём в очередь, а не пишем в Firestore напрямую — у воркера нет и не должно быть
    // токена от базы, только от бота. TTL сутки — если раннер вдруг не заберёт запись
    // (например, GitHub на профилактике), она не провисит там вечно.
    await env.DECISIONS.put(
      `${Date.now()}-${cq.id}`,
      JSON.stringify({ tradeId, action, label, at: new Date().toISOString() }),
      { expirationTtl: 86400 },
    );

    await tg(token, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: `${cq.message.text ? escapeHtml(cq.message.text) : tradeId}\n\n<i>→ ${escapeHtml(label)}</i>`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }, // решение принято — кнопки больше не нужны
    });
    await tg(token, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: action === 'skipped' ? `Записала причину: ${label.toLowerCase()}.` : `Записала: ${label.toLowerCase()}.`,
    });

    return new Response('ok');
  },
};
