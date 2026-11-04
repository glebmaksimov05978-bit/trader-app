// api/advisor.js — Vercel Edge Function: ИИ-советник (Pro).
//
// Защита (lib/serverGuard.js): только вошедший пользователь с подтверждённой почтой и ролью pro/admin;
// ограничены размер запроса, число сообщений и длина «системной инструкции» — чтобы функцию нельзя было
// превратить в бесплатный универсальный ИИ за счёт владельца ключа.
import { requireUser, readJsonBody, json } from '../lib/serverGuard.js';

export const config = { runtime: 'edge' };

const MAX_BODY_CHARS = 6_000_000; // картинки приходят base64 — запас на них
const MAX_MESSAGES = 40;
const MAX_SYSTEM_CHARS = 20_000;
const MAX_TEXT_CHARS = 30_000; // на одно текстовое сообщение

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  return messages.every((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (typeof m.content === 'string') return m.content.length <= MAX_TEXT_CHARS;
    return Array.isArray(m.content); // части с картинкой — по размеру ограничены телом запроса
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const guard = await requireUser(req, { roles: ['pro', 'admin'] });
  if (guard.error) return guard.error;

  const parsed = await readJsonBody(req, MAX_BODY_CHARS);
  if (parsed.error) return parsed.error;
  const { messages, systemPrompt } = parsed.body || {};
  if (!validMessages(messages)) return json({ error: 'Неверный список сообщений.' }, 400);
  if (systemPrompt != null && (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_CHARS)) {
    return json({ error: 'Слишком длинная инструкция.' }, 400);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      // Текст ошибки поставщика наружу не отдаём (в нём бывают детали аккаунта), в журнал функции — да.
      console.error('advisor: upstream', response.status, (await response.text()).slice(0, 300));
      return json({ error: 'ИИ-советник сейчас недоступен. Попробуйте позже.' }, 502);
    }

    const data = await response.json();
    return json({ content: data.content?.[0]?.text || '' });
  } catch (err) {
    console.error('advisor:', err.message);
    return json({ error: 'ИИ-советник сейчас недоступен. Попробуйте позже.' }, 500);
  }
}
