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

export default {
  // Будильник для робота уведомлений/бумажных сделок.
  //
  // Почему это здесь, а не просто в расписании самого GitHub Actions: собственное
  // расписание GitHub (`schedule: cron:`) — best-effort и НЕ гарантирует частоту. На
  // практике за 9 дней с cron "каждые 15 минут" реально сработало 16 раз вместо
  // ожидаемых нескольких сотен — то есть робот почти не искал новые сделки и почти
  // не проверял открытые позиции. Cloudflare Cron Triggers устроены иначе: они
  // не полагаются на очередь самого GitHub, а по своему надёжному таймеру САМИ стучатся
  // в GitHub API и просят немедленно запустить workflow (workflow_dispatch) — это не
  // «расписание», а обычный API-вызов по требованию, и он не подвержен той же проблеме.
  //
  // Сам робот при этом не переехал: код и логика остаются в GitHub Actions (там же
  // Firebase, esmify исходников и т.д.) — воркер только нажимает на кнопку «запустить
  // сейчас» по расписанию, которое реально соблюдается.
  async scheduled(event, env, ctx) {
    if (!env.GITHUB_PAT) {
      console.error('GITHUB_PAT не задан — будильник не может достучаться до GitHub');
      return;
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
      console.error(`Будильник: GitHub ответил ${res.status} ${await res.text()}`);
    }
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/order') return handleOrder(request, env);
    if (path === '/order/config') return handleOrderConfig(request, env);

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
