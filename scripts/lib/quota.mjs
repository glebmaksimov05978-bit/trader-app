// scripts/lib/quota.mjs
//
// Общее для роботов: распознать «исчерпан бесплатный дневной лимит базы» и сказать об этом человеческим языком.
//
// Почему это отдельный файл. У бесплатного тарифа Firebase (Spark) — 50 000 чтений документов в сутки на весь проект,
// лимит обнуляется около полуночи по тихоокеанскому времени (зимой это 11:00 по Москве). Когда он кончается, ВСЕ шаги
// робота, которые читают базу, падают с кодом 8 (RESOURCE_EXHAUSTED) — в письме от GitHub видно только «Process completed
// with exit code 1» и причину не понять (так было 2026-11-06…09: письма о сбоях, а утренняя сводка приходила лишь после 11:00).
// Теперь причина пишется в лог и в аннотацию запуска явно.
//
// Модуль без зависимостей — его подключают и роботы, и тесты.

/** Ошибка Firestore «исчерпана квота»? (gRPC-код 8 или текст) */
export function isQuotaError(e) {
  if (!e) return false;
  if (e.code === 8 || e.code === 'resource-exhausted') return true;
  const msg = String(e.message || e);
  return /RESOURCE_EXHAUSTED|Quota exceeded|quota.*exceeded|exceeded.*quota/i.test(msg);
}

/** Подсказка для лога, если ошибка — квота; иначе null. */
export function quotaHint(e) {
  if (!isQuotaError(e)) return null;
  return 'Исчерпан бесплатный дневной лимит чтений базы Firebase (50 000 в сутки). Он обнуляется около 11:00 по Москве; '
    + 'до тех пор шаги робота, читающие базу, не работают. Посмотреть расход: консоль Firebase → Firestore → Usage.';
}

/** Конец работы шага при необходимости упасть: пишет понятную причину и выходит с кодом. */
export function failWith(e, code = 1) {
  const hint = quotaHint(e);
  if (hint) console.error(`::error title=Лимит базы Firebase::${hint}`);
  console.error(e);
  process.exit(code);
}
