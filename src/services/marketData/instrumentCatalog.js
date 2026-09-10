// src/services/marketData/instrumentCatalog.js
//
// Каталог инструментов — чтобы «за кем следить» можно было ВЫБРАТЬ, а не вспоминать
// тикер по буквам. До этого единственным способом добавить что-то в радар было вписать
// тикер руками: опечатался — получил строку с ошибкой и не понял, инструмента нет или
// сломался запрос.
//
// Каталог двухслойный, и это сознательно:
//
//   1. Встроенный список (ниже) — работает без интернета, без токена, у любого аккаунта.
//      Это ликвидная часть MOEX: то, чем реально торгуют, а не все 300 бумаг доски.
//   2. Поиск Tinkoff (searchInstruments) — если у трейдера сохранён токен, к локальным
//      совпадениям добавляется живой поиск по всей бирже. Он же авторитетнее: биржа
//      переименовывает бумаги (редомициляции 2024–2025 — тому пример), а встроенный
//      список — это снимок.
//
// Поэтому у части записей есть `aliases`: поиск по старому тикеру всё равно находит
// бумагу, а в радар уходит текущий. Полностью список пересобирается скриптом
// scripts/buildInstrumentCatalog.mjs с самой биржи — руками его править не обязательно.

export const SECTORS = [
  'Нефть и газ',
  'Металлы и добыча',
  'Финансы',
  'IT и интернет',
  'Телеком',
  'Потребительский',
  'Электроэнергетика',
  'Транспорт',
  'Строительство',
  'Химия',
  'Здравоохранение',
  'Холдинги',
  'Фьючерсы',
];

// type: 'stock' | 'future' | 'currency' — то же поле, что у радара и сделок.
export const CATALOG = [
  // --- Нефть и газ ---
  { ticker: 'GAZP', name: 'Газпром', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'LKOH', name: 'Лукойл', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'ROSN', name: 'Роснефть', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'NVTK', name: 'Новатэк', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'TATN', name: 'Татнефть', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'TATNP', name: 'Татнефть (прив.)', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'SNGS', name: 'Сургутнефтегаз', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'SNGSP', name: 'Сургутнефтегаз (прив.)', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'SIBN', name: 'Газпром нефть', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'BANE', name: 'Башнефть', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'BANEP', name: 'Башнефть (прив.)', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'TRNFP', name: 'Транснефть (прив.)', type: 'stock', sector: 'Нефть и газ' },
  { ticker: 'RNFT', name: 'РуссНефть', type: 'stock', sector: 'Нефть и газ' },

  // --- Металлы и добыча ---
  { ticker: 'GMKN', name: 'Норникель', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'CHMF', name: 'Северсталь', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'NLMK', name: 'НЛМК', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'MAGN', name: 'ММК', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'PLZL', name: 'Полюс', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'RUAL', name: 'Русал', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'ALRS', name: 'Алроса', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'MTLR', name: 'Мечел', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'MTLRP', name: 'Мечел (прив.)', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'VSMO', name: 'ВСМПО-АВИСМА', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'SELG', name: 'Селигдар', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'RASP', name: 'Распадская', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'ENPG', name: 'Эн+ Груп', type: 'stock', sector: 'Металлы и добыча' },
  { ticker: 'UGLD', name: 'Южуралзолото (ЮГК)', type: 'stock', sector: 'Металлы и добыча' },

  // --- Финансы ---
  { ticker: 'SBER', name: 'Сбербанк', type: 'stock', sector: 'Финансы' },
  { ticker: 'SBERP', name: 'Сбербанк (прив.)', type: 'stock', sector: 'Финансы' },
  { ticker: 'VTBR', name: 'ВТБ', type: 'stock', sector: 'Финансы' },
  { ticker: 'MOEX', name: 'Московская биржа', type: 'stock', sector: 'Финансы' },
  { ticker: 'T', name: 'Т-Технологии', type: 'stock', sector: 'Финансы', aliases: ['TCSG', 'TCS', 'ТИНЬКОФФ'] },
  { ticker: 'SVCB', name: 'Совкомбанк', type: 'stock', sector: 'Финансы' },
  { ticker: 'BSPB', name: 'Банк Санкт-Петербург', type: 'stock', sector: 'Финансы' },
  { ticker: 'CBOM', name: 'МКБ', type: 'stock', sector: 'Финансы' },
  { ticker: 'MBNK', name: 'МТС Банк', type: 'stock', sector: 'Финансы' },
  { ticker: 'RENI', name: 'Ренессанс Страхование', type: 'stock', sector: 'Финансы' },
  { ticker: 'SFIN', name: 'ЭсЭфАй', type: 'stock', sector: 'Финансы' },

  // --- IT и интернет ---
  { ticker: 'YDEX', name: 'Яндекс', type: 'stock', sector: 'IT и интернет', aliases: ['YNDX'] },
  { ticker: 'OZON', name: 'Озон', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'VKCO', name: 'ВК', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'POSI', name: 'Positive Technologies', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'ASTR', name: 'Группа Астра', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'DIAS', name: 'Диасофт', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'SOFL', name: 'Софтлайн', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'HEAD', name: 'Хэдхантер', type: 'stock', sector: 'IT и интернет', aliases: ['HHRU'] },
  { ticker: 'WUSH', name: 'Вуш (Whoosh)', type: 'stock', sector: 'IT и интернет' },
  { ticker: 'DELI', name: 'Делимобиль', type: 'stock', sector: 'IT и интернет' },

  // --- Телеком ---
  { ticker: 'MTSS', name: 'МТС', type: 'stock', sector: 'Телеком' },
  { ticker: 'RTKM', name: 'Ростелеком', type: 'stock', sector: 'Телеком' },
  { ticker: 'RTKMP', name: 'Ростелеком (прив.)', type: 'stock', sector: 'Телеком' },

  // --- Потребительский ---
  { ticker: 'MGNT', name: 'Магнит', type: 'stock', sector: 'Потребительский' },
  { ticker: 'X5', name: 'X5 Group', type: 'stock', sector: 'Потребительский', aliases: ['FIVE', 'ПЯТЁРОЧКА'] },
  { ticker: 'LENT', name: 'Лента', type: 'stock', sector: 'Потребительский' },
  { ticker: 'BELU', name: 'Novabev Group', type: 'stock', sector: 'Потребительский', aliases: ['БЕЛУГА'] },
  { ticker: 'FIXP', name: 'Fix Price', type: 'stock', sector: 'Потребительский' },
  { ticker: 'MVID', name: 'М.Видео', type: 'stock', sector: 'Потребительский' },
  { ticker: 'ABRD', name: 'Абрау-Дюрсо', type: 'stock', sector: 'Потребительский' },
  { ticker: 'RAGR', name: 'Русагро', type: 'stock', sector: 'Потребительский', aliases: ['AGRO'] },

  // --- Электроэнергетика ---
  { ticker: 'IRAO', name: 'Интер РАО', type: 'stock', sector: 'Электроэнергетика' },
  { ticker: 'HYDR', name: 'РусГидро', type: 'stock', sector: 'Электроэнергетика' },
  { ticker: 'FEES', name: 'Россети', type: 'stock', sector: 'Электроэнергетика' },
  { ticker: 'UPRO', name: 'Юнипро', type: 'stock', sector: 'Электроэнергетика' },
  { ticker: 'MSNG', name: 'Мосэнерго', type: 'stock', sector: 'Электроэнергетика' },
  { ticker: 'OGKB', name: 'ОГК-2', type: 'stock', sector: 'Электроэнергетика' },
  { ticker: 'LSNGP', name: 'Ленэнерго (прив.)', type: 'stock', sector: 'Электроэнергетика' },

  // --- Транспорт ---
  { ticker: 'AFLT', name: 'Аэрофлот', type: 'stock', sector: 'Транспорт' },
  { ticker: 'NMTP', name: 'НМТП', type: 'stock', sector: 'Транспорт' },
  { ticker: 'FLOT', name: 'Совкомфлот', type: 'stock', sector: 'Транспорт' },
  { ticker: 'FESH', name: 'ДВМП (FESCO)', type: 'stock', sector: 'Транспорт' },

  // --- Строительство ---
  { ticker: 'PIKK', name: 'ПИК', type: 'stock', sector: 'Строительство' },
  { ticker: 'LSRG', name: 'ЛСР', type: 'stock', sector: 'Строительство' },
  { ticker: 'SMLT', name: 'Самолёт', type: 'stock', sector: 'Строительство' },
  { ticker: 'ETLN', name: 'Эталон', type: 'stock', sector: 'Строительство' },

  // --- Химия ---
  { ticker: 'PHOR', name: 'ФосАгро', type: 'stock', sector: 'Химия' },
  { ticker: 'AKRN', name: 'Акрон', type: 'stock', sector: 'Химия' },
  { ticker: 'KZOS', name: 'Казаньоргсинтез', type: 'stock', sector: 'Химия' },
  { ticker: 'NKNC', name: 'Нижнекамскнефтехим', type: 'stock', sector: 'Химия' },
  { ticker: 'KAZT', name: 'КуйбышевАзот', type: 'stock', sector: 'Химия' },
  { ticker: 'SGZH', name: 'Сегежа', type: 'stock', sector: 'Химия' },

  // --- Здравоохранение ---
  { ticker: 'MDMG', name: 'Мать и дитя', type: 'stock', sector: 'Здравоохранение' },
  { ticker: 'APTK', name: 'Аптечная сеть 36,6', type: 'stock', sector: 'Здравоохранение' },

  // --- Холдинги ---
  { ticker: 'AFKS', name: 'АФК Система', type: 'stock', sector: 'Холдинги' },

  // --- Фьючерсы (вечные контракты MOEX) ---
  { ticker: 'IMOEXF', name: 'Индекс МосБиржи', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'USDRUBF', name: 'Доллар/рубль', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'CNYRUBF', name: 'Юань/рубль', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'EURRUBF', name: 'Евро/рубль', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'GLDRUBF', name: 'Золото', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'SLVRUBF', name: 'Серебро', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'SBERF', name: 'Сбербанк (фьючерс)', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'GAZPF', name: 'Газпром (фьючерс)', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'LKOHF', name: 'Лукойл (фьючерс)', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'ROSNF', name: 'Роснефть (фьючерс)', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'GMKNF', name: 'Норникель (фьючерс)', type: 'future', sector: 'Фьючерсы' },
  { ticker: 'VTBRF', name: 'ВТБ (фьючерс)', type: 'future', sector: 'Фьючерсы' },
];

const norm = (s) => (s || '').toString().trim().toUpperCase();

export function catalogEntry(ticker) {
  const t = norm(ticker);
  return CATALOG.find((i) => i.ticker === t)
    || CATALOG.find((i) => (i.aliases || []).some((a) => norm(a) === t))
    || null;
}

/**
 * Поиск по встроенному списку. Порядок специально не «умный»: сначала точное совпадение
 * тикера, потом начало тикера, потом вхождение в название. Трейдер, который начал
 * печатать SBER, должен увидеть Сбербанк первой строкой, а не «Сбербанк (прив.)».
 */
export function searchCatalog(query, { limit = 40, sector = null } = {}) {
  const q = norm(query);
  const pool = sector ? CATALOG.filter((i) => i.sector === sector) : CATALOG;
  if (!q) return pool.slice(0, limit);

  const scored = [];
  for (const item of pool) {
    const t = item.ticker;
    const name = norm(item.name);
    const aliasHit = (item.aliases || []).some((a) => norm(a).startsWith(q));
    let score = null;
    if (t === q) score = 0;
    else if (t.startsWith(q)) score = 1;
    else if (aliasHit) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 4;
    else if (t.includes(q)) score = 5;
    if (score != null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.ticker.localeCompare(b.item.ticker));
  return scored.slice(0, limit).map((s) => s.item);
}

// Ответ Tinkoff → та же форма, что у записи каталога, чтобы список рисовался одним кодом.
function fromTinkoff(instrument) {
  const kind = instrument.instrumentKind || instrument.instrumentType || '';
  const type = /FUTURES|future/i.test(kind) ? 'future'
    : /CURRENCY|currency/i.test(kind) ? 'currency'
      : 'stock';
  return {
    ticker: norm(instrument.ticker),
    name: instrument.name || instrument.ticker,
    type,
    sector: null,
    source: 'tinkoff',
  };
}

/**
 * Полный поиск: встроенный список + живой поиск Tinkoff, если есть токен.
 * Локальные совпадения всегда впереди — они точнее размечены (сектор, человеческое имя),
 * а биржевой поиск добавляет хвост из того, чего в списке нет.
 *
 * Сеть здесь необязательна: упал запрос — вернём то, что нашли локально. Каталог не
 * должен переставать работать из-за того, что биржа недоступна.
 */
export async function searchInstruments({ query, tinkoffToken, sector = null, limit = 40 }) {
  const local = searchCatalog(query, { limit, sector });
  const q = norm(query);
  // Биржевой поиск имеет смысл только под осмысленный запрос и когда фильтр по сектору
  // не выбран — у результатов Tinkoff сектора нет, они бы просто не попали в фильтр.
  if (!tinkoffToken || q.length < 2 || sector) return local;

  try {
    const { TinkoffAPI } = await import('../tinkoff');
    const api = new TinkoffAPI(tinkoffToken);
    const found = await api.findInstruments(q);
    const seen = new Set(local.map((i) => i.ticker));
    const extra = [];
    for (const raw of found) {
      const item = fromTinkoff(raw);
      if (!item.ticker || seen.has(item.ticker)) continue;
      seen.add(item.ticker);
      extra.push(item);
    }
    return [...local, ...extra].slice(0, limit);
  } catch {
    return local;
  }
}
