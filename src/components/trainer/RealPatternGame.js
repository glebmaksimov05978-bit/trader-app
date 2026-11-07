// src/components/trainer/RealPatternGame.js
//
// «Фигуры на реальных графиках»: настоящая история Мосбиржи, на которой алгоритм приложения нашёл фигуру и после неё цена
// прошла заметное расстояние. Игрок видит график ДО находки (тикер и даты скрыты), называет фигуру, затем видит реальное
// продолжение и то, что сказал алгоритм. Считается не «верно/неверно», а СОГЛАСИЕ с алгоритмом — так проверяется и игрок, и
// сам алгоритм. Примеры собирает scripts/trainerRealPatterns.mjs (public/trainer/real_patterns.json), логика — services/trainer/realPatterns.js.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CandleChart from '../shared/CandleChart';
import Icon from '../shared/Icon';
import { PATTERN_NAMES, THEORY, NONE_ID } from '../../services/trainer/patternQuiz';
import {
  decodeExample, splitExample, pickNext, buildOptions, emptyRealProgress, applyVerdict, realSummary, movementText,
} from '../../services/trainer/realPatterns';
import { PATTERN_LABELS } from '../../services/analytics/patterns';

const FILE = `${process.env.PUBLIC_URL || ''}/trainer/real_patterns.json`;
const fmtDay = (d) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export default function RealPatternGame({ progress, onProgress }) {
  // Свой экземпляр прогресса: сводка обновляется сразу после ответа, не дожидаясь, пока профиль запишется и вернётся с базы.
  const [prog, setProg] = useState(() => progress || emptyRealProgress());
  useEffect(() => { if (progress) setProg(progress); }, [progress]);
  const [data, setData] = useState({ loading: true, items: [], meta: null, error: null });
  const [only, setOnly] = useState('');
  const [ex, setEx] = useState(null);
  const [options, setOptions] = useState([]);
  const [answer, setAnswer] = useState(null);
  const [last, setLast] = useState(null);
  const seen = useRef([]);

  useEffect(() => {
    let alive = true;
    fetch(FILE)
      .then((r) => { if (!r.ok) throw new Error(`файл примеров не найден (${r.status})`); return r.json(); })
      .then((j) => { if (alive) setData({ loading: false, items: j.items || [], meta: j, error: null }); })
      .catch((e) => { if (alive) setData({ loading: false, items: [], meta: null, error: e.message || 'не удалось загрузить примеры' }); });
    return () => { alive = false; };
  }, []);

  const next = useCallback((lastTruth = null, filter = only) => {
    const it = pickNext(data.items, { seen: seen.current, lastTruth, only: filter || null });
    if (!it) { setEx(null); return; }
    seen.current.push(it.id);
    const decoded = decodeExample(it);
    setEx(decoded);
    setOptions(buildOptions(decoded.truth));
    setAnswer(null); setLast(null);
  }, [data.items, only]);

  // Первый пример — как только данные пришли
  useEffect(() => { if (!data.loading && data.items.length && !ex) next(null); }, [data.loading, data.items, ex, next]);

  const answered = answer != null;
  const split = useMemo(() => (ex ? splitExample(ex) : null), [ex]);
  const sum = realSummary(prog);

  const onAnswer = (id) => {
    if (answered || !ex) return;
    const r = applyVerdict(prog, ex, id);
    setAnswer(id); setLast({ agree: r.agree });
    setProg(r.progress);
    onProgress?.(r.progress);
  };

  const markers = useMemo(() => {
    if (!answered || !ex) return undefined;
    const m = [{ date: ex.candles[ex.cut].date, text: 'Находка алгоритма' }];
    ex.points.forEach((p) => m.push({ date: p.date, text: p.type === 'low' ? 'впадина' : p.type === 'high' ? 'вершина' : 'точка' }));
    return m;
  }, [answered, ex]);

  if (data.loading) return <div className="card"><p className="tr-muted">Загружаю реальные примеры…</p></div>;
  if (data.error || !data.items.length) {
    return (
      <div className="card tr-scope">
        <Icon name="warning" size={14} />
        <span>Реальные примеры не загрузились{data.error ? `: ${data.error}` : ''}. Проверьте связь и обновите страницу. Пока можно играть во вкладке «Учебные фигуры».</span>
      </div>
    );
  }

  const patternsInSet = Array.from(new Set(data.items.map((x) => x.truth)));
  const nameOf = (id) => PATTERN_NAMES[id] || id;
  const theory = ex ? THEORY[ex.truth] : null;

  return (
    <div className="tr-grid">
      <div className="tr-main">
        <div className="tr-scope">
          <Icon name="info" size={14} />
          <span>
            Это <b>настоящие графики</b> Мосбиржи, где алгоритм приложения нашёл фигуру и после неё цена прошла заметное расстояние
            ({data.meta?.minMoveAtr ?? 2.5}+ ATR за {data.meta?.horizon ?? 20} свечей, вверх или вниз).
            Правильного ответа тут нет — есть <b>название от алгоритма</b>. Вы выбираете своё, а потом видите, согласны ли вы с ним и что было дальше.
          </span>
        </div>

        <div className="tr-levels" role="tablist" aria-label="Какую фигуру тренировать">
          <button type="button" role="tab" aria-selected={!only} className={`tr-chip ${!only ? 'active' : ''}`} onClick={() => { setOnly(''); next(ex?.truth, ''); }}>Все фигуры</button>
          {patternsInSet.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={only === id} className={`tr-chip ${only === id ? 'active' : ''}`} onClick={() => { setOnly(id); next(null, id); }}>{nameOf(id)}</button>
          ))}
        </div>

        {ex && split && (
          <div className="card tr-chart-card">
            <div className="tr-chart-head">
              <b>{answered ? `${ex.ticker} · ${fmtDay(ex.candles[0].date)} — ${fmtDay(ex.candles[ex.candles.length - 1].date)}` : 'Реальный график (инструмент и даты скрыты)'}</b>
              <span className="badge badge-purple">Учебный</span>
            </div>
            <CandleChart
              candles={answered ? ex.candles : split.visible}
              ticker={answered ? ex.ticker : 'Реальный график'}
              timeframe="D1"
              height={420}
              fitAll
              systemMarkers={markers}
            />
            {!answered ? (
              <>
                <h3 className="tr-q">Какая фигура на графике?</h3>
                <div className="tr-options" data-tour="trainer-options">
                  {options.map((id) => (
                    <button key={id} type="button" className="btn btn-secondary" onClick={() => onAnswer(id)}>{nameOf(id)}</button>
                  ))}
                </div>
                <p className="tr-hint">Показан график до момента, когда алгоритм заметил фигуру. «Фигуры нет» — тоже ответ: алгоритм мог ошибиться.</p>
              </>
            ) : (
              <div className="tr-reveal">
                <div className={`tr-verdict ${last.agree ? 'ok' : 'bad'}`}>
                  <Icon name={last.agree ? 'checkCircle' : 'xCircle'} size={18} />
                  <span>
                    {last.agree
                      ? `Вы согласны с алгоритмом: ${nameOf(ex.truth)}`
                      : `Расходитесь: алгоритм увидел «${nameOf(ex.truth).toLowerCase()}», вы выбрали «${nameOf(answer).toLowerCase()}»`}
                  </span>
                </div>
                <div className="tr-detector">
                  <h4><Icon name="radar" size={14} /> Что сказал алгоритм</h4>
                  <p>{PATTERN_LABELS[ex.detector] || ex.detector} — уверенность {ex.confidence} %. Точки фигуры отмечены на графике.</p>
                  <p>{movementText(ex, data.meta?.horizon)}</p>
                  <p className="tr-note">
                    Продолжение справа от отметки «Находка алгоритма» — настоящее. Отбирались примеры, где цена заметно двигалась, поэтому
                    такая картинка есть не всегда: на рынке много находок, после которых ничего не происходит.
                  </p>
                </div>
                {theory && ex.truth !== NONE_ID && (
                  <div className="tr-theory">
                    <h4>{theory.name}</h4>
                    <p><b>Как выглядит.</b> {theory.look}</p>
                    <p><b>Ловушка.</b> {theory.trap}</p>
                  </div>
                )}
                <button type="button" className="btn btn-primary" onClick={() => next(ex.truth)}>Следующий график</button>
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="tr-side">
        <div className="card">
          <h3 className="tr-side-title">Вы и алгоритм</h3>
          {sum.n === 0 ? (
            <p className="tr-muted">Ответьте на несколько графиков — здесь появится, как часто вы согласны с алгоритмом.</p>
          ) : (
            <>
              <div className="tr-kv"><span>Ответов</span><b>{sum.n}</b></div>
              <div className="tr-kv"><span>Согласны с алгоритмом</span><b>{Math.round(sum.agreement * 100)} %</b></div>
              {sum.rows.map((r) => (
                <div key={r.id} className="tr-weak"><span>{nameOf(r.id)}</span><b>{Math.round(r.share * 100)} %</b><small>{r.agree} из {r.n}</small></div>
              ))}
              {sum.disputed.length > 0 && (
                <p className="tr-note" style={{ marginTop: 10 }}>
                  Спорные фигуры: {sum.disputed.map((r) => nameOf(r.id).toLowerCase()).join(', ')}. Там вы чаще расходитесь с алгоритмом — либо глаз
                  ошибается, либо алгоритм называет фигурой то, что ею не является. Стоит пересмотреть эти примеры внимательнее.
                </p>
              )}
            </>
          )}
        </div>
        <div className="card">
          <h3 className="tr-side-title">Зачем это</h3>
          <p className="tr-muted">Учебные графики просты: фигура нарисована по учебнику. Здесь — как фигуры выглядят на самом деле, и как с ними справляется наш алгоритм. Победы тут нет: проверяется согласие, а не угадывание.</p>
        </div>
      </aside>
    </div>
  );
}
