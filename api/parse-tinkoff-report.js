// api/parse-tinkoff-report.js — Vercel Edge Function, AI fallback for Tinkoff report parsing
//
// Защита (lib/serverGuard.js): только вошедший пользователь с подтверждённой почтой (роль любая —
// импорт отчёта нужен и бесплатным). Инструкция для ИИ зашита здесь, пользователь присылает только текст
// отчёта, его размер ограничен.
import { requireUser, readJsonBody, json } from '../lib/serverGuard.js';

export const config = { runtime: 'edge' };

const MAX_BODY_CHARS = 400_000;

const SYSTEM_PROMPT = `Ты парсер брокерских отчётов Т-Инвестиций (Тинькофф). Тебе дают сырой текст, извлечённый из PDF (порядок слов может быть искажён построчной экстракцией). Найди в тексте:

1. Раздел "1.1 Информация о совершенных и исполненных сделках на конец отчетного периода" — таблица с 34 колонками на строку сделки: Номер сделки, Номер поручения, Признак исполнения, Дата заключения (ДД.ММ.ГГГГ), Время (ЧЧ:ММ:СС), Торговая площадка, Вид сделки (Покупка/Продажа/РЕПО 1/РЕПО 2), Наименование актива, Код актива, Цена за единицу, Валюта цены, Количество, Сумма (без НКД), НКД, Сумма сделки, Валюта расчетов, Комиссия брокера, ..., далее прочие колонки.
2. Раздел "1.2 Информация о неисполненных сделках" — считай количество строк, не разбирай подробно.
3. Раздел "1.3 Сделки ... прекращены не в результате исполнения" — считай количество строк.
4. Раздел "4.1 Информация о ценных бумагах" — таблица (Наименование актива, Код актива, ISIN, Код гос. регистрации, Тип, Наименование эмитента).

Верни СТРОГО валидный JSON (без markdown, без пояснений) следующей структуры:
{
  "transactions": [
    {"dealNumber": "123", "executedFlag": false, "date": "01.07.2025", "time": "10:15:30", "exchange": "ММВБ", "dealType": "Покупка", "assetName": "Позитив Технолоджиз ао", "code": "POSI", "price": "1302.80", "currency": "RUB", "quantity": "10", "amount": "13028.00", "commission": "1.30", "tradeMode": "TQBR"}
  ],
  "unexecuted": [{"dealNumber": "..."}],
  "cancelled": [{"dealNumber": "..."}],
  "section41": [{"name": "Позитив Технолоджиз ао", "code": "POSI", "isin": "RU000A103X66"}]
}

Правила: "commission" — сумма комиссии брокера + биржи + клирингового центра + гербового сбора для этой строки. Числа — без разделителей тысяч, десятичная точка. "price" и "quantity" обязательны и должны быть валидными числами. Не пропускай ни одной строки сделки из раздела 1.1. Если "Признак исполнения" не пустой — укажи executedFlag: true.`;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const guard = await requireUser(req);
  if (guard.error) return guard.error;

  try {
    const parsedBody = await readJsonBody(req, MAX_BODY_CHARS);
    if (parsedBody.error) return parsedBody.error;
    const { rawText } = parsedBody.body || {};
    if (!rawText || typeof rawText !== 'string') {
      return json({ error: 'rawText is required' }, 400);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: rawText.slice(0, 100000) }],
      }),
    });

    if (!response.ok) {
      // Текст ошибки поставщика наружу не отдаём, в журнал функции — да.
      console.error('parse-tinkoff-report: upstream', response.status, (await response.text()).slice(0, 300));
      return json({ error: 'ИИ-разбор сейчас недоступен. Попробуйте позже.' }, 502);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (e) {
      return json({ error: 'ИИ вернул неразборчивый ответ: ' + e.message }, 502);
    }

    return json(parsed);
  } catch (err) {
    console.error('parse-tinkoff-report:', err.message);
    return json({ error: 'ИИ-разбор сейчас недоступен. Попробуйте позже.' }, 500);
  }
}
