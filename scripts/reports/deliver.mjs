// scripts/reports/deliver.mjs
//
// Куда робот может доставить готовый PDF-отчёт, кроме Telegram: электронная почта (SMTP, пакет nodemailer) и мессенджер MAX
// (Bot API: platform-api2.max.ru). Telegram живёт в runScheduledReports.mjs (sendDocument).
//
// Правила:
//  • Ключи — только в переменных окружения (GitHub Secrets), в репозиторий и в сообщения об ошибках не попадают.
//  • Любая функция отправки возвращает { ok: true } или { ok: false, error: 'понятный текст' } и не бросает исключений —
//    сбой одного канала не должен мешать остальным.
//  • Всё внешнее (fetch, nodemailer-транспорт, пауза) передаётся снаружи — проверяется тестами без сети.

const MAX_API = 'https://platform-api2.max.ru';

/** Короткий текст ошибки без секретов (пароль/токен вырезаются, если вдруг попали в сообщение). */
export function cleanError(e, secrets = []) {
  let t = String((e && (e.response || e.message)) || e || 'ошибка').replace(/\s+/g, ' ').trim();
  for (const s of secrets) if (s && String(s).length >= 4) t = t.split(String(s)).join('***');
  return t.slice(0, 200);
}

// ---------------------------------------------------------------- почта

/** Настройки почты из окружения; null — если чего-то не хватает. */
export function smtpConfigFromEnv(env = process.env) {
  const host = (env.SMTP_HOST || '').trim(), user = (env.SMTP_USER || '').trim(), pass = env.SMTP_PASS || '';
  if (!host || !user || !pass) return null;
  const port = Number(env.SMTP_PORT) || 465;
  return { host, port, secure: port === 465, user, pass, from: (env.SMTP_FROM || '').trim() || user };
}

/** Транспорт nodemailer по настройкам; nodemailer подгружается только когда почта действительно нужна. */
export async function createSmtpTransport(cfg) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch { throw new Error('пакет nodemailer не установлен в задании робота'); }
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 40000,
  });
}

/** Письмо с PDF во вложении. */
export async function sendEmail({ transport, from, to, subject, text, filename, buffer, secrets = [] }) {
  if (!transport) return { ok: false, error: 'почта не настроена (нет SMTP_HOST / SMTP_USER / SMTP_PASS)' };
  try {
    const info = await transport.sendMail({
      from: { name: 'TraderPro', address: from }, to, subject, text,
      attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
    });
    const rejected = (info && info.rejected) || [];
    if (rejected.length) return { ok: false, error: `адрес отклонён: ${rejected.join(', ')}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: cleanError(e, secrets) };
  }
}

/** Тема и текст письма по подписи отчёта. */
export function emailParts(model, caption) {
  return {
    subject: `TraderPro — отчёт: ${model.meta.period.title}`,
    text: `${caption}\n\nОтчёт в файле PDF — во вложении.\n\nЭто письмо отправил робот TraderPro по вашему расписанию. Расписание можно изменить в приложении: Отчёт → Выгрузить отчёт → По расписанию.`,
  };
}

// ---------------------------------------------------------------- MAX

/** Настройки MAX из окружения; null — если бот не подключён. Получатель: личный чат (MAX_USER_ID) или группа (MAX_CHAT_ID). */
export function maxConfigFromEnv(env = process.env) {
  const token = (env.MAX_BOT_TOKEN || '').trim();
  const userId = (env.MAX_USER_ID || '').trim(), chatId = (env.MAX_CHAT_ID || '').trim();
  if (!token || !(userId || chatId)) return null;
  return { token, userId, chatId, apiBase: (env.MAX_API_BASE || MAX_API).replace(/\/$/, '') };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const maxMessage = (data, status) => (data && (data.message || data.code || data.error)) ? `${data.code ? `${data.code}: ` : ''}${data.message || data.error || ''}`.replace(/: $/, '') : `HTTP ${status}`;
async function json(res) { try { return await res.json(); } catch { return null; } }

/**
 * Файл в MAX: 1) запросить адрес загрузки (POST /uploads?type=file) → 2) залить файл (поле «data») → 3) отправить сообщение
 * с вложением по токену файла (POST /messages). Сразу после загрузки файл бывает «не готов» (attachment.not.ready) — тогда
 * сообщение повторяется с нарастающими паузами.
 * Схема взята из документации dev.max.ru; на живом боте ещё не проверялась.
 */
export async function sendMaxDocument({ token, userId, chatId, filename, buffer, caption, apiBase = MAX_API, fetchImpl = fetch, sleep = wait, retryDelays = [1000, 2000, 4000, 8000, 15000] }) {
  const secrets = [token];
  try {
    const head = { Authorization: token };
    const up = await fetchImpl(`${apiBase}/uploads?type=file`, { method: 'POST', headers: head });
    const upData = await json(up);
    if (up.status < 200 || up.status >= 300) return { ok: false, error: `загрузка: ${cleanError(maxMessage(upData, up.status), secrets)}` };
    if (!upData?.url) return { ok: false, error: 'загрузка: MAX не вернул адрес для файла' };

    const form = new FormData();
    form.append('data', new Blob([buffer], { type: 'application/pdf' }), filename);
    // токен бота на адрес загрузки НЕ отправляем: этот адрес может быть на другом сервере, а в нём уже зашита подпись
    const put = await fetchImpl(upData.url, { method: 'POST', body: form });
    const putData = await json(put);
    if (put.status < 200 || put.status >= 300) return { ok: false, error: `загрузка файла: ${cleanError(maxMessage(putData, put.status), secrets)}` };
    const fileToken = upData.token || putData?.token;
    if (!fileToken) return { ok: false, error: 'загрузка файла: MAX не вернул токен файла' };

    const q = userId ? `user_id=${encodeURIComponent(userId)}` : `chat_id=${encodeURIComponent(chatId)}`;
    const body = JSON.stringify({ text: String(caption || '').slice(0, 4000), attachments: [{ type: 'file', payload: { token: fileToken } }] });
    let last = null;
    for (let i = 0; i <= retryDelays.length; i++) {
      const res = await fetchImpl(`${apiBase}/messages?${q}`, { method: 'POST', headers: { ...head, 'Content-Type': 'application/json' }, body });
      const data = await json(res);
      if (res.status >= 200 && res.status < 300) return { ok: true };
      last = maxMessage(data, res.status);
      const notReady = /attachment\.not\.ready|not\.ready|file\.not\.processed/i.test(`${data?.code || ''} ${data?.message || ''}`);
      if (!notReady || i === retryDelays.length) break;
      await sleep(retryDelays[i]);
    }
    return { ok: false, error: `сообщение: ${cleanError(last, secrets)}` };
  } catch (e) {
    return { ok: false, error: cleanError(e, secrets) };
  }
}

/** Что из каналов подключено в этом запуске робота (приложение показывает это в окне настройки). */
export function channelStatusFromEnv(env = process.env) {
  return {
    telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    email: !!smtpConfigFromEnv(env),
    max: !!maxConfigFromEnv(env),
  };
}
