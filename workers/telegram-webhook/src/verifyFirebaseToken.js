// workers/telegram-webhook/src/verifyFirebaseToken.js
//
// Проверка Firebase ID-токена внутри воркера.
//
// Зачем: отправка заявки — единственная в приложении операция, которая тратит настоящие
// деньги, и адрес воркера рано или поздно станет известен (он в коде фронтенда). Значит
// нужен способ доказать, что запрос пришёл именно от владельца, а не от того, кто нашёл
// URL. Общий секрет для этого не годится: код в браузере открыт, любой секрет в нём —
// уже не секрет.
//
// Firebase ID-токен подписан приватным ключом Google, а проверяется публичным. Браузер
// его получает при входе, воркер проверяет подпись и содержимое — и никаких секретов
// пересылать не приходится. Токен живёт час, так что перехваченный устаревает сам.
//
// Проверяем всё, что положено: подпись, издателя, адресата, срок, время выдачи и что
// это тот самый uid. Пропустить любую из этих проверок — значит принять чужой валидный
// токен от другого проекта Firebase.

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let cachedKeys = null;
let cachedUntil = 0;

async function getKeys() {
  const now = Date.now();
  if (cachedKeys && now < cachedUntil) return cachedKeys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`не удалось получить ключи Google: ${res.status}`);
  const json = await res.json();
  // Google сам говорит, сколько ключи живут. Берём это время, а не выдуманное: ключи
  // ротируются, и слишком долгий кэш однажды начнёт отвергать нормальные токены.
  const cc = res.headers.get('cache-control') || '';
  const maxAge = parseInt((cc.match(/max-age=(\d+)/) || [])[1] || '3600', 10);
  cachedKeys = json.keys || [];
  cachedUntil = now + maxAge * 1000;
  return cachedKeys;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/**
 * @param {string} idToken     - Firebase ID-токен из браузера
 * @param {string} projectId   - id проекта Firebase
 * @param {string} expectedUid - uid владельца; чужой валидный токен не подойдёт
 * @returns {Promise<{ok: true, uid: string} | {ok: false, error: string}>}
 */
export async function verifyFirebaseToken(idToken, projectId, expectedUid) {
  try {
    if (!idToken || typeof idToken !== 'string') return { ok: false, error: 'нет токена' };
    if (!projectId) return { ok: false, error: 'воркер не знает projectId' };

    const parts = idToken.split('.');
    if (parts.length !== 3) return { ok: false, error: 'токен повреждён' };
    const [headerB64, payloadB64, sigB64] = parts;

    const header = b64urlToJson(headerB64);
    if (header.alg !== 'RS256') return { ok: false, error: 'неожиданный алгоритм подписи' };

    const keys = await getKeys();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, error: 'ключ подписи неизвестен' };

    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key,
      b64urlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return { ok: false, error: 'подпись не сходится' };

    const p = b64urlToJson(payloadB64);
    const now = Math.floor(Date.now() / 1000);
    const skew = 60; // небольшой запас на расхождение часов

    if (p.aud !== projectId) return { ok: false, error: 'токен от другого проекта' };
    if (p.iss !== `https://securetoken.google.com/${projectId}`) return { ok: false, error: 'неверный издатель' };
    if (!p.sub) return { ok: false, error: 'в токене нет пользователя' };
    if (typeof p.exp !== 'number' || p.exp + skew < now) return { ok: false, error: 'токен истёк' };
    if (typeof p.iat !== 'number' || p.iat - skew > now) return { ok: false, error: 'токен из будущего' };
    if (expectedUid && p.sub !== expectedUid) return { ok: false, error: 'это не владелец счёта' };

    return { ok: true, uid: p.sub };
  } catch (e) {
    return { ok: false, error: `проверка токена не удалась: ${e.message}` };
  }
}
