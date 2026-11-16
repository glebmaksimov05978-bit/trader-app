// src/components/cockpit/NewsPanel.js
//
// Вкладка «Новости» под графиком в Сопровождении: заголовки, которые касаются инструмента (нефть, газ, валюта, банк…),
// и отдельно — геополитика и макро. Источник — бесплатные RSS-ленты, их собирает функция сайта /api/news (кэш 10 минут).
// Только для контекста: связь новостей с ценой не проверялась, сигналом это не является.
import React, { useEffect, useMemo, useState } from 'react';
import { newsFor } from '../../services/news/newsParse';

let cache = null; // { at, data } — одна загрузка на открытую страницу раз в 5 минут
async function loadNews() {
  if (cache && Date.now() - cache.at < 5 * 60000) return cache.data;
  const res = await fetch('/api/news');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.items)) throw new Error('пустой ответ');
  cache = { at: Date.now(), data };
  return data;
}

const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(1, m)} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function List({ items }) {
  if (!items.length) return <div className="ck-line-sub">Свежих заголовков нет.</div>;
  return (
    <ul className="nw-list">
      {items.map((x) => (
        <li key={x.link}>
          <a href={x.link} target="_blank" rel="noopener noreferrer">{x.title}</a>
          <span className="nw-meta">{x.source}{x.lang === 'en' ? ' · EN' : ''} · {ago(x.at)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function NewsPanel({ ticker, name }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    loadNews()
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, data: null, error: e.message || 'не загрузились' }); });
    return () => { alive = false; };
  }, []);
  const picked = useMemo(() => (state.data ? newsFor(state.data.items, { ticker, name }) : null), [state.data, ticker, name]);
  const down = (state.data?.sources || []).filter((s) => !s.ok).length;

  return (
    <section className="ck-panel nw-wrap">
      {state.loading && <div className="ck-line-sub">Загружаю новости…</div>}
      {state.error && (
        <div className="ck-line-sub">
          Новости не загрузились ({state.error}). Их собирает сайт — при запуске приложения на своём компьютере вкладка пустая.
        </div>
      )}
      {picked && (
        <>
          <div className="nw-block">
            <h3>По инструменту {ticker}</h3>
            {picked.words.length
              ? <List items={picked.instrument} />
              : <div className="ck-line-sub">Для этого инструмента нет списка тем — показана только геополитика.</div>}
          </div>
          <div className="nw-block">
            <h3>Геополитика и макро</h3>
            <List items={picked.geo} />
          </div>
          <p className="ck-line-sub nw-note">
            За последние 3 дня, из бесплатных лент: РБК, Интерфакс, ТАСС, Ведомости, BBC, Guardian, Al Jazeera, OilPrice, CNBC
            {down ? ` (сейчас не ответили: ${down})` : ''}. Только для контекста — связь новостей с ценой мы не проверяли, это не сигнал.
          </p>
        </>
      )}
    </section>
  );
}
