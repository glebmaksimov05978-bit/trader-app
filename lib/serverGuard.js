// lib/serverGuard.js
//
// Охрана платных серверных функций сайта (api/advisor.js, api/parse-tinkoff-report.js).
//
// Раньше эти функции не проверяли, кто их вызывает: любой, кто узнал адрес, мог гонять платный ключ
// Anthropic (а у советника ещё и подставлять любую «системную инструкцию» — получался бесплатный
// универсальный ИИ за ваш счёт). Теперь: нужен вход в аккаунт (Firebase ID-токен проверяется по
// подписи Google — тот же проверенный код, что у воркера заявок), почта подтверждена, а для
// советника — ещё и роль pro/admin (читается из профиля самим пользователем по его же токену,
// поэтому правила Firestore работают как обычно и ничьё чужое поле не читается).
//
// Файл лежит вне папки api/, чтобы Vercel не превращал его в отдельную функцию.
import { verifyFirebaseToken } from '../workers/telegram-webhook/src/verifyFirebaseToken.js';

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'trader-app-6517b'; // не секрет: он и так виден в коде сайта

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// Роль пользователя из его профиля. Запрос идёт с токеном самого пользователя, а не админским ключом.
async function readRole(uid, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) return null;
  const doc = await res.json();
  return doc?.fields?.role?.stringValue ?? null;
}

/**
 * @param {Request} req
 * @param {{ roles?: string[] }} [opts] - если задано, роль пользователя должна быть в списке
 * @returns {Promise<{ uid: string } | { error: Response }>}
 */
export async function requireUser(req, opts = {}) {
  const idToken = bearer(req);
  if (!idToken) return { error: json({ error: 'Нужен вход в аккаунт.' }, 401) };
  const who = await verifyFirebaseToken(idToken, PROJECT_ID, null);
  if (!who.ok) return { error: json({ error: 'Вход не подтверждён. Войдите заново.' }, 401) };
  if (!who.emailVerified) return { error: json({ error: 'Подтвердите почту, чтобы пользоваться этой функцией.' }, 403) };
  if (opts.roles?.length) {
    const role = await readRole(who.uid, idToken);
    if (!role || !opts.roles.includes(role)) {
      return { error: json({ error: 'Функция доступна только в Pro.' }, 403) };
    }
  }
  return { uid: who.uid };
}

// Размер тела запроса: смотрим и заголовок, и сам текст (заголовок можно не прислать).
export async function readJsonBody(req, maxChars) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > maxChars) return { error: json({ error: 'Запрос слишком большой.' }, 413) };
  const text = await req.text();
  if (text.length > maxChars) return { error: json({ error: 'Запрос слишком большой.' }, 413) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: 'Неверный формат запроса.' }, 400) };
  }
}
