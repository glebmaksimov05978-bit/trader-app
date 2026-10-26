// api/tg.js — Vercel Edge Function: прокси к Telegram для роботов из России (Яндекс Облако).
//
// Оттуда api.telegram.org не открывается, а Vercel — открывается, и Telegram виден самому Vercel.
// Робот шлёт запрос на  <сайт>/tg/bot<токен>/<метод>  (Vercel переписывает его сюда, см. vercel.json),
// функция пересылает его в Telegram и возвращает ответ.
//
// Защита: токен в адресе должен совпасть с токеном бота из переменной окружения Vercel
// TELEGRAM_BOT_TOKEN (его знает только владелец), и разрешены лишь методы отправки/правки сообщений.
export const config = { runtime: 'edge' };

const METHODS = new Set(['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'answerCallbackQuery', 'getMe']);

export default async function handler(req) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const p = new URL(req.url).searchParams.get('path') || '';
  const m = /^bot([^/]+)\/([A-Za-z]+)$/.exec(p);
  if (!token || !m || m[1] !== token) return new Response('forbidden', { status: 403 });
  if (!METHODS.has(m[2])) return new Response('method not allowed', { status: 405 });
  const body = req.method === 'POST' ? await req.text() : undefined;
  const res = await fetch(`https://api.telegram.org/bot${token}/${m[2]}`, {
    method: req.method === 'POST' ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body } : {}),
  });
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
