// src/components/trainer/PatternGame.js
//
// «Увидеть фигуру»: учебный график с вложенной фигурой (или без неё), игрок называет фигуру, затем видит продолжение,
// краткую теорию и то, что на этом же графике «увидел» алгоритм приложения. Логика раундов и очков — services/trainer/patternQuiz.js.
import React, { useMemo, useState, useCallback } from 'react';
import CandleChart from '../shared/CandleChart';
import Icon from '../shared/Icon';
import { computePatternsAtEntry, PATTERN_LABELS } from '../../services/analytics/patterns';
import {
  LEVELS, THEORY, PATTERN_NAMES, NONE_ID, buildRound, splitRound, emptyProgress, applyAnswer, progressSummary,
  compareWithDetector, levelForXp,
} from '../../services/trainer/patternQuiz';

const newSeed = () => Math.floor(Math.random() * 1e9) + 1;
// Следующий график — не с той же фигурой, что только что была (раньше подряд попадались одинаковые).
function seedAvoiding(levelId, avoidTruth) {
  let s = newSeed();
  for (let i = 0; i < 40 && avoidTruth; i++) {
    if (buildRound({ levelId, seed: s }).truth !== avoidTruth) break;
    s = newSeed();
  }
  return s;
}

export default function PatternGame({ progress, onProgress }) {
  const prog = progress || emptyProgress();
  const unlocked = levelForXp(prog.xp).id;
  const [levelId, setLevelId] = useState(unlocked);
  const [seed, setSeed] = useState(newSeed);
  const [answer, setAnswer] = useState(null);      // выбранный id фигуры; null — ещё не отвечали
  const [last, setLast] = useState(null);          // { correct, gained }

  const round = useMemo(() => buildRound({ levelId, seed }), [levelId, seed]);
  const { visible } = useMemo(() => splitRound(round), [round]);
  const answered = answer != null;

  // Что на этом графике увидел алгоритм приложения (только после ответа — чтобы не подсказывать).
  const detector = useMemo(() => {
    if (!answered) return null;
    let cands = [];
    try {
      const r = computePatternsAtEntry(visible, visible[visible.length - 1].date, { timeframeMinutes: 1440 });
      cands = (r?.candidates || []).filter((c) => !/^(pin_bar|engulfing)/.test(c.pattern));
    } catch { /* детектор не должен ронять игру */ }
    return { cands, cmp: compareWithDetector(round, answer, cands) };
  }, [answered, visible, round, answer]);

  const onAnswer = useCallback((id) => {
    if (answered) return;
    const res = applyAnswer(prog, round, id);
    setAnswer(id);
    setLast({ correct: res.correct, gained: res.gained });
    onProgress?.(res.progress);
  }, [answered, prog, round, onProgress]);

  const next = () => { setAnswer(null); setLast(null); setSeed(seedAvoiding(levelId, round.truth)); };
  const sum = progressSummary(prog);
  const level = LEVELS.find((l) => l.id === levelId) || LEVELS[0];
  const cur = sum.level;
  const toNext = sum.next ? Math.max(0, sum.next.xpFrom - prog.xp) : 0;
  const barPct = sum.next ? Math.min(100, ((prog.xp - cur.xpFrom) / (sum.next.xpFrom - cur.xpFrom)) * 100) : 100;
  const theory = THEORY[round.truth];

  return (
    <div className="tr-grid">
      <div className="tr-main">
        <div className="tr-statbar" data-tour="trainer-progress">
          <div className="tr-level">
            <span className="tr-level-n">Уровень {cur.id}</span>
            <span className="tr-level-name">{cur.name}</span>
          </div>
          <div className="tr-xp" title={sum.next ? `До уровня «${sum.next.name}» — ${toNext} очков` : 'Максимальный уровень'}>
            <div className="tr-xp-fill" style={{ width: `${barPct}%` }} />
          </div>
          <div className="tr-stats">
            <span><b>{prog.xp}</b> очков</span>
            <span>серия <b>{prog.streak}</b></span>
            <span>точность <b>{sum.accuracy == null ? '—' : `${Math.round(sum.accuracy * 100)} %`}</b></span>
          </div>
        </div>

        <div className="tr-levels" role="tablist" aria-label="Уровень сложности">
          {LEVELS.map((l) => (
            <button key={l.id} type="button" role="tab" aria-selected={l.id === levelId}
              className={`tr-chip ${l.id === levelId ? 'active' : ''}`} disabled={l.id > unlocked}
              title={l.id > unlocked ? `Откроется с ${l.xpFrom} очков` : l.name}
              onClick={() => { setLevelId(l.id); setAnswer(null); setLast(null); setSeed(newSeed()); }}>
              {l.id > unlocked && <Icon name="lock" size={12} />} {l.id}. {l.name}
            </button>
          ))}
        </div>

        <div className="card tr-chart-card">
          <CandleChart
            candles={answered ? round.candles : visible}
            ticker="Учебный график"
            timeframe="D1"
            height={400}
            fitAll
            systemMarkers={answered ? [{ date: visible[visible.length - 1].date, text: 'Вопрос' }] : undefined}
          />
          {!answered ? (
            <>
              <h3 className="tr-q">Какая фигура на графике?</h3>
              <div className="tr-options" data-tour="trainer-options">
                {round.options.map((id) => (
                  <button key={id} type="button" className="btn btn-secondary" onClick={() => onAnswer(id)}>{PATTERN_NAMES[id]}</button>
                ))}
              </div>
              <p className="tr-hint">Уровень «{level.name}»: шум {level.noise}. {level.withNone ? 'Фигуры может не быть — это тоже ответ.' : 'Фигура есть всегда.'}</p>
            </>
          ) : (
            <div className="tr-reveal">
              <div className={`tr-verdict ${last.correct ? 'ok' : 'bad'}`}>
                <Icon name={last.correct ? 'checkCircle' : 'xCircle'} size={18} />
                <span>
                  {last.correct ? `Верно: ${PATTERN_NAMES[round.truth]}` : `Нет. Это ${PATTERN_NAMES[round.truth].toLowerCase()}, вы выбрали «${PATTERN_NAMES[answer].toLowerCase()}»`}
                  {last.correct && last.gained > 0 && <em> +{last.gained} очков</em>}
                </span>
              </div>

              <div className="tr-theory">
                <h4>{theory.name}</h4>
                <p><b>Как выглядит.</b> {theory.look}</p>
                <p><b>Логика.</b> {theory.logic}</p>
                <p><b>Ловушка.</b> {theory.trap}</p>
                {round.truth !== NONE_ID && (
                  <p className="tr-note">Продолжение справа от отметки «Вопрос» нарисовано по логике фигуры — это учебная модель. На реальном рынке фигура не гарантирует такого продолжения.</p>
                )}
              </div>

              {detector && (
                <div className="tr-detector" data-tour="trainer-detector">
                  <h4><Icon name="radar" size={14} /> Что увидел алгоритм приложения</h4>
                  {detector.cands.length === 0 ? (
                    <p>На видимой части графика алгоритм не нашёл ни одной фигуры{round.truth === NONE_ID ? ' — для этого графика это верно.' : '.'}</p>
                  ) : (
                    <ul>
                      {detector.cands.slice(0, 4).map((c, i) => (
                        <li key={i}>{PATTERN_LABELS[c.pattern] || c.pattern} — уверенность {c.confidence} %</li>
                      ))}
                    </ul>
                  )}
                  <p className="tr-note">
                    {detector.cmp.falseAlarm && 'График без фигуры, а алгоритм что-то «увидел» — ложная тревога. Это частая история: ему нужен ваш фильтр. '}
                    {round.truth !== NONE_ID && !detector.cmp.detectorFound && 'Нужной фигуры среди найденных нет. '}
                    {detector.cmp.detectorFound && !detector.cmp.detectorTopRight && 'Нужная фигура среди найденных есть, но не самая уверенная. '}
                    {detector.cmp.detectorTopRight && 'Нужная фигура — самая уверенная из найденных. '}
                    Это проверка на учебных графиках, не на живом рынке.
                  </p>
                </div>
              )}

              <button type="button" className="btn btn-primary" onClick={next}>Следующий график</button>
            </div>
          )}
        </div>
      </div>

      <aside className="tr-side">
        <div className="card">
          <h3 className="tr-side-title">Ваши слабые места</h3>
          {prog.answered < 5 ? (
            <p className="tr-muted">Ответьте хотя бы на 5 графиков — тогда появится разбор.</p>
          ) : (
            <>
              {sum.weak.length === 0 && <p className="tr-muted">Слабых мест пока не видно (нужно хотя бы 5 ответов по одной фигуре).</p>}
              {sum.weak.map((w) => (
                <div key={w.id} className="tr-weak"><span>{PATTERN_NAMES[w.id]}</span><b>{Math.round(w.accuracy * 100)} %</b><small>{w.n} графиков</small></div>
              ))}
              {sum.topConfusion && (
                <p className="tr-note" style={{ marginTop: 10 }}>
                  Чаще всего вы путаете «{PATTERN_NAMES[sum.topConfusion.truth].toLowerCase()}» с «{PATTERN_NAMES[sum.topConfusion.answer].toLowerCase()}» ({sum.topConfusion.n} раз).
                </p>
              )}
            </>
          )}
        </div>
        <div className="card">
          <h3 className="tr-side-title">О чём эта игра</h3>
          <p className="tr-muted">Учит узнавать фигуры и — не менее важно — не видеть их там, где их нет. Графики учебные: фигура вложена в случайный шум, ответ известен заранее. Победа здесь не означает прибыль на рынке.</p>
        </div>
      </aside>
    </div>
  );
}
