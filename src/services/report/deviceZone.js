// src/services/report/deviceZone.js — часовой пояс устройства (телефона или компьютера); не удалось определить — Москва.
// Вынесено в отдельный файл, чтобы окно расписаний можно было проверять тестом с любым поясом.
import { MSK_TZ, isValidTimeZone } from './schedule';

export function deviceZone() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(z) ? z : MSK_TZ;
  } catch { return MSK_TZ; }
}
