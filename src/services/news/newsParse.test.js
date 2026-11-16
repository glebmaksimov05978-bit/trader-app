import { parseRss, newsFor, wordsFor } from './newsParse';

const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Цены на нефть Brent выросли после решения ОПЕК+]]></title><link>https://example.ru/a</link><pubDate>Mon, 16 Nov 2026 10:00:00 +0300</pubDate></item>
<item><title>EU weighs new sanctions on Russia &amp; shipping</title><link>https://example.com/b</link><pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate></item>
<item><title>Сбербанк отчитался о прибыли</title><link>https://example.ru/c</link><pubDate>Mon, 16 Nov 2026 09:00:00 +0300</pubDate></item>
<item><title>Без даты</title><link>https://example.ru/d</link></item>
<item><title>Погода в Москве</title><link>https://example.ru/e</link><pubDate>Mon, 16 Nov 2026 08:00:00 +0300</pubDate></item>
</channel></rss>`;

test('разбор RSS: заголовок, ссылка, время; без даты — пропуск; сущности раскрыты', () => {
  const items = parseRss(rss, { id: 'x', name: 'Пример', lang: 'ru' });
  expect(items).toHaveLength(4);
  expect(items[0].title).toBe('Цены на нефть Brent выросли после решения ОПЕК+');
  expect(items[1].title).toBe('EU weighs new sanctions on Russia & shipping');
  expect(items[1].at).toBe('2026-11-16T12:00:00.000Z');
  expect(items[0].source).toBe('Пример');
});

test('слова для инструмента: группа и название компании', () => {
  expect(wordsFor('BRZ6')).toEqual(expect.arrayContaining(['нефт', 'brent']));
  expect(wordsFor('SBER', 'Сбербанк')).toEqual(expect.arrayContaining(['банк', 'сбербан']));
});

test('отбор: по инструменту и геополитика, свежие сверху, без повторов', () => {
  const items = parseRss(rss, { id: 'x', name: 'Пример' });
  const now = Date.parse('2026-11-16T15:00:00Z');
  const br = newsFor(items, { ticker: 'BRZ6', now });
  expect(br.instrument.map((x) => x.link)).toEqual(['https://example.ru/a']);
  expect(br.geo.map((x) => x.link)).toEqual(['https://example.com/b']);
  const sb = newsFor(items, { ticker: 'SBER', name: 'Сбербанк', now });
  expect(sb.instrument.map((x) => x.link)).toEqual(['https://example.ru/c']);
  // Старше окна — не показываются.
  expect(newsFor(items, { ticker: 'BRZ6', now: now + 10 * 86400000 }).instrument).toHaveLength(0);
});
