// api/news.js — Vercel Edge Function: свежие заголовки из бесплатных RSS-лент для вкладки «Новости» в Сопровождении.
//
// Ленты фиксированные (NEWS_SOURCES) — адрес снаружи не передаётся, поэтому функцию нельзя использовать как прокси
// куда угодно. Ответ кэшируется на CDN Vercel на 10 минут: сколько бы людей ни открыло вкладку, к изданиям уходит
// не больше одного запроса в 10 минут. Отбор «что касается инструмента» делает уже приложение (newsParse.newsFor).
import { NEWS_SOURCES, parseRss } from '../src/services/news/newsParse.js';

export const config = { runtime: 'edge' };

const TIMEOUT_MS = 6000;

async function fetchSource(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(src.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-reader)', Accept: 'application/rss+xml, application/xml, text/xml' }, redirect: 'follow' });
    if (!res.ok) return { id: src.id, ok: false, error: `HTTP ${res.status}`, items: [] };
    const xml = await res.text();
    const items = parseRss(xml, src);
    return { id: src.id, ok: true, items };
  } catch (e) {
    return { id: src.id, ok: false, error: e?.name === 'AbortError' ? 'не ответил вовремя' : 'недоступен', items: [] };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const results = await Promise.all(NEWS_SOURCES.map(fetchSource));
  const items = results.flatMap((r) => r.items)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 600);
  const sources = results.map((r) => ({ id: r.id, ok: r.ok, count: r.items.length, error: r.error || null }));
  return new Response(JSON.stringify({ updatedAt: new Date().toISOString(), sources, items }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800',
    },
  });
}
