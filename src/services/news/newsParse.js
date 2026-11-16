// src/services/news/newsParse.js
//
// Новости для контекста: заголовки из бесплатных RSS-лент (российские деловые и зарубежные про геополитику) и отбор
// «что касается этого инструмента». Берём только заголовок, ссылку, время и источник — текст статей не копируем,
// читать — по ссылке у самого издания.
//
// Модуль без зависимостей: его читает и серверная функция api/news.js (собирает ленты), и приложение (отбор по
// инструменту). Разбор RSS — регулярными выражениями: на сервере (Edge) нет DOMParser.

export const NEWS_SOURCES = [
  { id: 'rbc', name: 'РБК', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', lang: 'ru' },
  { id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss', lang: 'ru' },
  { id: 'tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', lang: 'ru' },
  { id: 'vedomosti', name: 'Ведомости', url: 'https://www.vedomosti.ru/rss/rubric/finance/markets', lang: 'ru' },
  { id: 'bbc', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', lang: 'en' },
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', lang: 'en' },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en' },
  { id: 'oilprice', name: 'OilPrice', url: 'https://oilprice.com/rss/main', lang: 'en' },
  { id: 'cnbc', name: 'CNBC World', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', lang: 'en' },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

/** RSS 2.0 → [{title, link, at, source, lang}] (без пустых и без дат из будущего дальше суток). */
export function parseRss(xml, source) {
  const out = [];
  const items = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of items) {
    const title = tag(block, 'title');
    let link = tag(block, 'link');
    if (!link) { const g = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i); link = g ? decode(g[1]) : ''; }
    const dateRaw = tag(block, 'pubDate') || tag(block, 'dc:date');
    const t = Date.parse(dateRaw);
    if (!title || !/^https?:\/\//.test(link) || !Number.isFinite(t)) continue;
    if (t > Date.now() + 86400000) continue;
    out.push({ title: title.slice(0, 300), link, at: new Date(t).toISOString(), source: source?.name || '', sourceId: source?.id || '', lang: source?.lang || 'ru' });
  }
  return out;
}

// --- отбор по смыслу ---
// Геополитика и макро — то, от чего по опыту владельца в основном зависят фьючерсы на Мосбирже.
export const GEO_WORDS = [
  'санкц', 'sanction', 'украин', 'ukrain', 'переговор', 'negotiat', 'peace', 'ceasefire', 'перемири', 'кремл', 'kremlin',
  'путин', 'putin', 'трамп', 'trump', 'нато', 'nato', 'войн', ' war', 'military', 'удар', 'strike', 'attack', 'пошлин',
  'tariff', 'opec', 'опек', 'потолок цен', 'price cap', 'эмбарго', 'embargo', 'russia', 'moscow', 'ключев', 'central bank',
];

const GROUPS = [
  { re: /^(BR|BM|CL|WTI|ROSN|LKOH|TATN|TATNP|SIBN|SNGS|SNGSP|BANE|BANEP)/i, words: ['нефт', 'brent', 'oil', 'opec', 'опек', 'crude', 'баррел', 'urals'] },
  { re: /^(NG|NR|GAZP|NVTK)/i, words: ['газ', ' gas', 'lng', 'спг', 'газпром'] },
  { re: /^(GD|GL|GOLD|SV|SILV|PT|PD|PLZL|UGLD|POLY|SELG)/i, words: ['золот', 'gold', 'серебр', 'silver', 'платин', 'драгметалл'] },
  { re: /^(SI|USDRUB|EU|EURRUB|CR|CNY|ED|UC)/i, words: ['рубл', 'доллар', 'юан', 'евро', 'курс', 'ruble', 'rouble', 'dollar', 'yuan', 'ключев', 'цб '] },
  { re: /^(IMOEX|MIX|MM|MX|RI|RTS|RM)/i, words: ['мосбирж', 'индекс мосбиржи', 'фондов', 'рынок акций', 'moex', 'индекс'] },
  { re: /^(SBER|SBERP|VTBR|T|TCSG|MOEX|BSPB|SVCB|CBOM)$/i, words: ['банк', 'ставк', 'цб ', 'кредит'] },
  { re: /^(GMKN|CHMF|NLMK|MAGN|RUAL|ALRS)/i, words: ['металл', 'никел', 'стал', 'алюмин', 'алмаз', 'nickel', 'steel', 'alumin'] },
];

/** Слова для инструмента: группа (нефть, газ, валюта…) + основа названия компании. */
export function wordsFor(ticker, name = '') {
  const t = String(ticker || '').toUpperCase();
  const words = new Set();
  for (const g of GROUPS) if (g.re.test(t)) g.words.forEach((w) => words.add(w));
  const stem = String(name || '').toLowerCase().replace(/[«»"]/g, '').split(/[\s-]+/).find((w) => w.length >= 4);
  if (stem) words.add(stem.slice(0, Math.max(4, Math.min(7, stem.length - 1))));
  return [...words];
}

const has = (title, words) => { const s = ` ${String(title).toLowerCase()} `; return words.some((w) => s.includes(w)); };

/**
 * Разложить новости для инструмента: «по инструменту» и «геополитика и макро». Свежие сверху, не старше maxAgeH.
 * @returns {{instrument: Array, geo: Array}}
 */
export function newsFor(items, { ticker, name, maxAgeH = 72, limit = 15, now = Date.now() } = {}) {
  const words = wordsFor(ticker, name);
  const fresh = (items || []).filter((x) => now - Date.parse(x.at) <= maxAgeH * 3600000)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const seen = new Set();
  const uniq = fresh.filter((x) => { const k = x.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
  const instrument = words.length ? uniq.filter((x) => has(x.title, words)).slice(0, limit) : [];
  const used = new Set(instrument.map((x) => x.link));
  const geo = uniq.filter((x) => !used.has(x.link) && has(x.title, GEO_WORDS)).slice(0, limit);
  return { instrument, geo, words };
}
