// src/components/strategies/SetupBuilder.js
//
// «Мой сетап» — конструктор правил генератора стратегий (шаг 2, раздел 18 паспорта приложения). Человек собирает
// правило из признаков (без ИИ: ИИ подключим после переезда на Яндекс), видит его человеческим текстом и сразу —
// «насколько это похоже на меня»: сколько сделок его журнала было сделано, когда правило выполнялось, и чем они
// кончились. Это зеркало, а не обещание прибыли: подача и цифры — честные, без вердиктов «провал».
//
// Расчёт — services/strategyBuilder (причинные признаки, допуск «точно/почти», сверка с журналом). Черновик хранится
// в браузере (удобство); сохранение в список стратегий и Сопровождение — следующий шаг.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FEATURES, OPERATORS, DISTANCE_UNITS, INSTRUMENT_CLASSES, FUTURE_GROUPS, CHARACTERS, HORIZONS, TIMEFRAME_LABELS,
  TIMEFRAME_MINUTES, PIVOT_LEVELS, SETUP_PRESETS, emptySpec, newCondition, validateSpec, describeCondition,
  paperOnlyReasons, specFromPreset,
} from '../../services/strategyBuilder/ruleSpec';
import { matchJournal } from '../../services/strategyBuilder/journalMatch';
import { planJournalLoad, loadJournalData, timeframesOf } from '../../services/strategyBuilder/journalData';
import { availableTimeframes, fetchDailyCandles } from '../../services/marketData/candles';
import { getUserTrades } from '../../services/trades';
import { rubText } from '../../services/leverageMath';
import './SetupBuilder.css';

const DRAFT_KEY = 'tp.setupDraft.v1';
const readDraft = () => {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.version === 1 && s.entry ? s : null;
  } catch { return null; }
};
const writeDraft = (s) => { try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(s)); } catch { /* приватный режим */ } };

const PARAM_LABELS = { period: 'период', smooth: 'сглаживание', signal: 'сигнальная', fast: 'быстрая', slow: 'медленная', k: 'ширина σ', bars: 'свечей', mult: 'множитель', type: 'средняя', level: 'уровень' };
const GROUPS = [...new Set(Object.values(FEATURES).map((f) => f.group))];
const numOr = (v, d) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const money = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${rubText(v)}`);
const deals = (n) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'сделок';
  if (b === 1) return 'сделка';
  if (b >= 2 && b <= 4) return 'сделки';
  return 'сделок';
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function FeatureSelect({ value, onChange, id }) {
  return (
    <select className="input sb-feature" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {Object.entries(FEATURES).filter(([, f]) => f.group === g).map(([fid, f]) => <option key={fid} value={fid}>{f.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function ParamInputs({ cond, onParams }) {
  const f = FEATURES[cond.feature.id];
  const keys = Object.keys(f?.params || {});
  if (!keys.length) return null;
  return keys.map((k) => {
    const v = cond.feature.params?.[k] ?? f.params[k];
    if (k === 'type') {
      return (
        <label key={k} className="sb-param">{PARAM_LABELS[k]}
          <select className="input" value={v} onChange={(e) => onParams({ [k]: e.target.value })}>
            <option value="ema">EMA</option><option value="sma">SMA</option>
          </select>
        </label>
      );
    }
    if (k === 'level') {
      return (
        <label key={k} className="sb-param">{PARAM_LABELS[k]}
          <select className="input" value={v} onChange={(e) => onParams({ [k]: e.target.value })}>
            {PIVOT_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      );
    }
    return (
      <label key={k} className="sb-param">{PARAM_LABELS[k] || k}
        <input className="input" type="number" min={k === 'mult' || k === 'k' ? 0.5 : 1} step={k === 'mult' || k === 'k' ? 0.5 : 1} value={v}
          onChange={(e) => onParams({ [k]: numOr(e.target.value, f.params[k]) })} />
      </label>
    );
  });
}

function ValueInput({ cond, onChange }) {
  const f = FEATURES[cond.feature.id];
  if (cond.op === 'rising' || cond.op === 'falling') {
    return (
      <label className="sb-param">свечей подряд
        <input className="input" type="number" min={1} max={50} value={cond.n ?? 3} onChange={(e) => onChange({ n: Math.round(numOr(e.target.value, 3)) })} />
      </label>
    );
  }
  const unit = f?.kind === 'distance' ? DISTANCE_UNITS[cond.feature.unit || 'pct'] : '';
  if (cond.op === 'between') {
    const [a, b] = Array.isArray(cond.value) ? cond.value : [0, 0];
    return (
      <span className="sb-between">
        <input className="input" type="number" step="any" value={a} aria-label="от" onChange={(e) => onChange({ value: [numOr(e.target.value, 0), b] })} />
        <span>и</span>
        <input className="input" type="number" step="any" value={b} aria-label="до" onChange={(e) => onChange({ value: [a, numOr(e.target.value, 0)] })} />
        {unit && <span className="sb-unit">{unit}</span>}
      </span>
    );
  }
  const v = Array.isArray(cond.value) ? cond.value[0] : cond.value;
  return (
    <span className="sb-value">
      <input className="input" type="number" step="any" value={v ?? 0} aria-label="значение" onChange={(e) => onChange({ value: numOr(e.target.value, 0) })} />
      {unit && <span className="sb-unit">{unit}</span>}
      {f?.range && f.range[1] - f.range[0] >= 20 && (
        <input type="range" min={f.range[0]} max={f.range[1]} value={v ?? 0} aria-label="ползунок" onChange={(e) => onChange({ value: Number(e.target.value) })} />
      )}
    </span>
  );
}

function ConditionRow({ cond, spec, onChange, onRemove, problems, index }) {
  const [more, setMore] = useState(!!(cond.ago || cond.feature.tf || (cond.side && cond.side !== 'both')));
  const f = FEATURES[cond.feature.id];
  const higherTfs = Object.keys(TIMEFRAME_MINUTES).filter((tf) => TIMEFRAME_MINUTES[tf] > TIMEFRAME_MINUTES[spec.timeframe]);
  const setFeature = (id) => {
    const nf = FEATURES[id];
    onChange({
      feature: { id, params: { ...(nf.params || {}) }, unit: nf.kind === 'distance' ? (cond.feature.unit || 'pct') : undefined, tf: cond.feature.tf },
      value: cond.op === 'between'
        ? (nf.range ? [nf.range[0], Math.round((nf.range[0] + nf.range[1]) / 2)] : [0, 1])
        : (nf.range ? Math.round((nf.range[0] + nf.range[1]) / 2) : 0),
    });
  };
  const setOp = (op) => {
    const patch = { op };
    if (op === 'between' && !Array.isArray(cond.value)) patch.value = [cond.value ?? 0, (cond.value ?? 0) + 1];
    if (op !== 'between' && Array.isArray(cond.value)) patch.value = cond.value[0];
    if ((op === 'rising' || op === 'falling') && !cond.n) patch.n = 3;
    onChange(patch);
  };
  const mine = problems.filter((p) => p.condId === cond.id);
  return (
    <div className={`sb-cond${mine.some((p) => p.level === 'error') ? ' sb-cond-bad' : ''}`}>
      <div className="sb-cond-main">
        <span className="sb-cond-n">{index + 1}</span>
        <FeatureSelect value={cond.feature.id} onChange={setFeature} id={`sb-f-${cond.id}`} />
        <ParamInputs cond={cond} onParams={(p) => onChange({ feature: { ...cond.feature, params: { ...cond.feature.params, ...p } } })} />
        {f?.kind === 'distance' && (
          <select className="input sb-narrow" value={cond.feature.unit || 'pct'} aria-label="единица" onChange={(e) => onChange({ feature: { ...cond.feature, unit: e.target.value } })}>
            <option value="pct">в %</option><option value="atr">в ATR</option>
          </select>
        )}
        <select className="input sb-narrow" value={cond.op} aria-label="сравнение" onChange={(e) => setOp(e.target.value)}>
          {Object.entries(OPERATORS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <ValueInput cond={cond} onChange={onChange} />
        {spec.entry.mode === 'score' && (
          <label className="sb-param">баллы
            <input className="input sb-tiny" type="number" min={0.5} step={0.5} value={cond.weight ?? 1} onChange={(e) => onChange({ weight: numOr(e.target.value, 1) })} />
          </label>
        )}
        {spec.entry.mode === 'score' && (
          <label className="mr-check"><input type="checkbox" checked={!!cond.required} onChange={(e) => onChange({ required: e.target.checked })} /> обязательно</label>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMore((v) => !v)}>{more ? 'меньше' : 'ещё'}</button>
        <button type="button" className="btn btn-ghost btn-sm sb-remove" aria-label="Убрать условие" onClick={onRemove}>✕</button>
      </div>
      {more && (
        <div className="sb-cond-more">
          <label className="sb-param">свечей назад
            <input className="input sb-tiny" type="number" min={0} max={50} value={cond.ago || 0} onChange={(e) => onChange({ ago: Math.max(0, Math.round(numOr(e.target.value, 0))) })} />
          </label>
          <label className="sb-param">график
            <select className="input" value={cond.feature.tf || ''} onChange={(e) => onChange({ feature: { ...cond.feature, tf: e.target.value || undefined } })}>
              <option value="">как у стратегии ({TIMEFRAME_LABELS[spec.timeframe]})</option>
              {higherTfs.map((tf) => <option key={tf} value={tf}>старший: {TIMEFRAME_LABELS[tf]}</option>)}
            </select>
          </label>
          {spec.direction === 'both' && (
            <label className="sb-param">для
              <select className="input" value={cond.side || 'both'} onChange={(e) => onChange({ side: e.target.value })}>
                <option value="both">лонга и шорта</option><option value="long">только лонга</option><option value="short">только шорта</option>
              </select>
            </label>
          )}
        </div>
      )}
      <div className="sb-cond-text">{describeCondition(cond)}</div>
      {mine.map((p) => <div key={p.text} className={`sb-problem sb-${p.level}`}>{p.text}</div>)}
    </div>
  );
}

function ExitEditor({ exit, onChange }) {
  const set = (k, v) => onChange({ ...exit, [k]: v });
  return (
    <div className="sb-exit">
      <label className="sb-param">стоп
        <span className="sb-pair">
          <select className="input sb-narrow" value={exit.stop?.type || 'none'} onChange={(e) => set('stop', e.target.value === 'none' ? { type: 'none' } : { type: e.target.value, value: exit.stop?.value || 1.5 })}>
            <option value="atr">ATR</option><option value="pct">%</option><option value="none">без стопа</option>
          </select>
          {exit.stop?.type && exit.stop.type !== 'none' && <input className="input sb-tiny" type="number" min={0.1} step={0.1} value={exit.stop.value} onChange={(e) => set('stop', { ...exit.stop, value: numOr(e.target.value, 1.5) })} />}
        </span>
      </label>
      <label className="sb-param">цель
        <span className="sb-pair">
          <select className="input sb-narrow" value={exit.target?.type || 'none'} onChange={(e) => set('target', e.target.value === 'none' ? { type: 'none' } : { type: e.target.value, value: exit.target?.value || 2 })}>
            <option value="r">R (стопов)</option><option value="atr">ATR</option><option value="pct">%</option><option value="none">без цели</option>
          </select>
          {exit.target?.type && exit.target.type !== 'none' && <input className="input sb-tiny" type="number" min={0.1} step={0.1} value={exit.target.value} onChange={(e) => set('target', { ...exit.target, value: numOr(e.target.value, 2) })} />}
        </span>
      </label>
      <label className="sb-param">следящий стоп
        <span className="sb-pair">
          <select className="input sb-narrow" value={exit.trailing?.type || 'none'} onChange={(e) => set('trailing', e.target.value === 'none' ? null : { type: e.target.value, value: exit.trailing?.value || 2 })}>
            <option value="none">нет</option><option value="atr">ATR</option><option value="pct">%</option>
          </select>
          {exit.trailing && <input className="input sb-tiny" type="number" min={0.1} step={0.1} value={exit.trailing.value} onChange={(e) => set('trailing', { ...exit.trailing, value: numOr(e.target.value, 2) })} />}
        </span>
      </label>
      <label className="sb-param">выйти через, свечей
        <input className="input sb-tiny" type="number" min={0} value={exit.maxBars || ''} placeholder="—" onChange={(e) => set('maxBars', e.target.value === '' || Number(e.target.value) <= 0 ? null : Math.round(Number(e.target.value)))} />
      </label>
      <label className="mr-check"><input type="checkbox" checked={!!exit.opposite} onChange={(e) => set('opposite', e.target.checked)} /> выход по обратному сигналу</label>
    </div>
  );
}

function GroupCard({ title, hint, g, tone }) {
  return (
    <div className={`sb-group sb-group-${tone}`}>
      <div className="sb-group-title">{title}</div>
      <div className="sb-group-n">{g.n} <span>{deals(g.n)}</span></div>
      <div className={`sb-group-pnl ${g.pnl > 0 ? 'pos' : g.pnl < 0 ? 'neg' : ''}`}>{g.n ? money(g.pnl) : '—'}</div>
      <div className="sb-group-sub">в среднем {g.n ? money(g.avgPnl) : '—'} · прибыльных {pct(g.winRate)}</div>
      <div className="sb-group-hint">{hint}</div>
    </div>
  );
}

const CLASS_LABEL = (id) => INSTRUMENT_CLASSES[id]?.label?.toLowerCase() || id;

function MatchResult({ m, spec, failed }) {
  const [show, setShow] = useState(null);
  const excludedParts = [
    ...Object.entries(m.excluded.byClass).map(([cls, n]) => `${CLASS_LABEL(cls)} — ${n}`),
    m.excluded.otherSide ? `другая сторона — ${m.excluded.otherSide}` : null,
    m.excluded.otherGroup ? `другие группы фьючерсов — ${m.excluded.otherGroup}` : null,
    m.excluded.otherTicker ? `не из вашего списка бумаг — ${m.excluded.otherTicker}` : null,
  ].filter(Boolean);
  const comparable = m.exact.n >= 5 && m.near.n >= 5;
  let nearNote = null;
  if (comparable) {
    const a = m.exact.avgPnl;
    const b = m.near.avgPnl;
    if (Math.sign(a) !== Math.sign(b) && Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 0.3) {
      nearNote = 'У сделок «почти по правилу» результат другого знака, чем у «точно». Возможно, порог подобран слишком точно под историю — попробуйте сдвинуть его и посмотреть, сохранится ли разница.';
    } else nearNote = 'У «точно» и «почти» результат одного знака — правило не держится на одном конкретном числе, это хороший признак.';
  }
  const list = show ? m[show].trades : [];
  return (
    <div className="sb-result">
      <p className="mr-note" style={{ marginTop: 0 }}>
        Проверено: {m.checked} {deals(m.checked)} вашего журнала ({INSTRUMENT_CLASSES[spec.instrumentClass]?.label.toLowerCase()},{' '}
        {spec.direction === 'both' ? 'лонг и шорт' : spec.direction === 'long' ? 'лонг' : 'шорт'}). Сигнал ищем на свечах {TIMEFRAME_LABELS[spec.timeframe]},
        закрывшихся перед входом (и до 2 свечей раньше).
      </p>
      <div className="sb-groups">
        <GroupCard title="Точно по правилу" hint="перед входом выполнялось всё" g={m.exact} tone="exact" />
        <GroupCard title="Почти" hint={`не хватило в пределах допуска ±${spec.tolerancePct}%`} g={m.near} tone="near" />
        <GroupCard title="Не по правилу" hint="правило перед входом не выполнялось" g={m.none} tone="none" />
      </div>
      {nearNote && <p className="mr-note">{nearNote}</p>}
      {m.smallSample && m.checked > 0 && (
        <p className="mr-note">Сделок «точно по правилу» меньше 30 — это наблюдение, а не вывод: такой результат легко получить случайно.</p>
      )}
      {(excludedParts.length > 0 || m.noData.length > 0 || failed.length > 0) && (
        <p className="mr-note">
          {excludedParts.length > 0 && <>Не участвуют: {excludedParts.join(', ')}. </>}
          {m.noData.length > 0 && <>Нет данных по {m.noData.length} {m.noData.length === 1 ? 'сделке' : 'сделкам'} (нет свечей или слишком мало истории до входа). </>}
          {failed.length > 0 && <>Не загрузились свечи: {failed.map((f) => f.ticker).join(', ')}.</>}
        </p>
      )}
      <div className="sb-list-tabs">
        {['exact', 'near'].map((k) => m[k].n > 0 && (
          <button key={k} type="button" className={`btn btn-ghost btn-sm${show === k ? ' on' : ''}`} onClick={() => setShow(show === k ? null : k)}>
            {show === k ? 'Скрыть' : 'Показать'} сделки «{k === 'exact' ? 'точно' : 'почти'}»
          </button>
        ))}
      </div>
      {show && (
        <div className="sb-trades">
          {list.slice().sort((a, b) => b.openedAt - a.openedAt).map((t) => (
            <div key={t.id} className="sb-trade">
              <div className="sb-trade-head">
                <b>{t.ticker}</b> <span>{t.side === 'short' ? 'шорт' : 'лонг'}</span>
                <span>{t.openedAt.toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span className={t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}>{money(t.pnl)}</span>
                {t.barsBeforeEntry > 0 && <span className="sb-muted">сигнал за {t.barsBeforeEntry} свеч. до входа</span>}
              </div>
              <div className="sb-trade-conds">
                {t.results.map((r) => {
                  const c = spec.entry.conditions.find((x) => x.id === r.condId);
                  if (!c) return null;
                  const val = typeof r.value !== 'number' ? '—'
                    : !Number.isFinite(r.value) ? 'уровня с этой стороны нет'
                      : (Math.round(r.value * 100) / 100).toLocaleString('ru-RU');
                  return (
                    <span key={r.condId} className={`sb-chip sb-chip-${r.state}`} title={describeCondition(c)}>
                      {r.state === 'exact' ? '✓' : r.state === 'near' ? '≈' : r.state === 'fail' ? '✗' : '?'} {describeCondition(c)}: {val}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JournalCheck({ spec, uid, token, valid }) {
  const [trades, setTrades] = useState(null);
  const [loaded, setLoaded] = useState(null); // { key, data, failed }
  const [progress, setProgress] = useState(null);
  const cancelRef = useRef(false);
  const key = `${spec.instrumentClass}|${spec.timeframe}|${timeframesOf(spec).sort().join(',')}|${(spec.futureGroups || []).join(',')}|${spec.direction}`;
  const stale = loaded && loaded.key !== key;

  const run = async () => {
    cancelRef.current = false;
    setProgress({ done: 0, total: 0, text: 'Загружаю журнал…' });
    try {
      const list = trades || await getUserTrades(uid);
      setTrades(list);
      const plan = planJournalLoad(spec, list);
      if (!plan.length) { setLoaded({ key, data: new Map(), failed: [] }); setProgress(null); return; }
      setProgress({ done: 0, total: plan.length, text: 'Загружаю свечи…' });
      const res = await loadJournalData(spec, plan, (a) => fetchDailyCandles({ ...a, tinkoffToken: token }), {
        onProgress: (p) => setProgress({ ...p, text: `Загружаю свечи: ${p.ticker}` }),
        isCancelled: () => cancelRef.current,
      });
      if (!cancelRef.current) setLoaded({ key, ...res });
    } catch (e) {
      setLoaded({ key, data: new Map(), failed: [{ ticker: 'журнал', error: e?.message || 'ошибка' }] });
    }
    setProgress(null);
  };

  // Правило пересчитывается сразу при каждой правке условий — свечи уже загружены, считать недолго.
  const m = useMemo(() => {
    if (!loaded || stale || !trades || !valid) return null;
    try { return matchJournal(spec, trades, (t) => loaded.data.get(String(t).toUpperCase()) || null); } catch { return null; }
  }, [loaded, stale, trades, spec, valid]);

  return (
    <div className="card sb-card">
      <div className="section-title" style={{ marginBottom: 4 }}>Насколько это похоже на вас</div>
      <p className="mr-note" style={{ marginTop: 0 }}>
        Ищем в вашем журнале сделки, перед которыми правило выполнялось, и сравниваем их с остальными. Это не прогноз
        прибыли, а зеркало: как вы на самом деле торговали в таких ситуациях.
      </p>
      {progress ? (
        <div className="sb-progress">
          {progress.text}{progress.total ? ` (${progress.done} из ${progress.total})` : ''}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { cancelRef.current = true; }}>Остановить</button>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" disabled={!valid || !uid} onClick={run}>
          {loaded && !stale ? 'Загрузить заново' : stale ? 'Сверить заново (сменился таймфрейм или класс)' : 'Сверить с журналом'}
        </button>
      )}
      {!valid && <p className="mr-note">Сначала исправьте ошибки в правиле выше.</p>}
      {loaded && !stale && trades && !m && valid && <p className="mr-note">Не удалось посчитать — проверьте условия.</p>}
      {loaded && !stale && loaded.data.size === 0 && !loaded.failed.length && (
        <p className="mr-note">В журнале нет закрытых сделок этого класса и направления — сверять не с чем. Начать можно с Тренажёра или бумажной торговли.</p>
      )}
      {m && m.checked + m.noData.length > 0 && <MatchResult m={m} spec={spec} failed={loaded.failed} />}
    </div>
  );
}

export default function SetupBuilder({ user, userProfile }) {
  const [spec, setSpec] = useState(() => readDraft() || specFromPreset('bounce'));
  useEffect(() => { writeDraft(spec); }, [spec]);
  const problems = useMemo(() => validateSpec(spec), [spec]);
  const errors = problems.filter((p) => p.level === 'error');
  const general = problems.filter((p) => !p.condId);
  const paperOnly = useMemo(() => paperOnlyReasons(spec), [spec]);
  const hasToken = !!userProfile?.tinkoffToken;
  const tfs = availableTimeframes(hasToken).filter((t) => t.key !== 'M5' && t.key !== 'M10');

  const patch = (p) => setSpec((s) => ({ ...s, ...p }));
  const setEntry = (p) => setSpec((s) => ({ ...s, entry: { ...s.entry, ...p } }));
  const setCond = (id, p) => setSpec((s) => ({ ...s, entry: { ...s.entry, conditions: s.entry.conditions.map((c) => (c.id === id ? { ...c, ...p } : c)) } }));
  const removeCond = (id) => setSpec((s) => ({ ...s, entry: { ...s.entry, conditions: s.entry.conditions.filter((c) => c.id !== id) } }));
  const addCond = (fid) => setSpec((s) => {
    const f = FEATURES[fid];
    return { ...s, entry: { ...s.entry, conditions: [...s.entry.conditions, newCondition(fid, { value: f.range ? Math.round((f.range[0] + f.range[1]) / 2) : 0 })] } };
  });
  const totalScore = spec.entry.conditions.reduce((a, c) => a + (c.weight ?? 1), 0);
  const character = CHARACTERS[spec.character];

  return (
    <>
      <div className="card sb-card">
        <div className="section-title" style={{ marginBottom: 4 }}>Мой сетап</div>
        <p className="mr-note" style={{ marginTop: 0 }}>
          Опишите, когда вы входите, — признаками и числами. Приложение покажет правило простыми словами и найдёт в вашем
          журнале сделки, сделанные по нему. Можно начать с заготовки и подкрутить под себя.
        </p>
        <div className="sb-presets">
          {SETUP_PRESETS.map((p) => (
            <button key={p.id} type="button" className="btn btn-ghost btn-sm" onClick={() => setSpec((s) => specFromPreset(p.id, { ...s }))}>{p.label}</button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSpec(emptySpec())}>С чистого листа</button>
        </div>

        <div className="sb-head">
          <label className="sb-param sb-wide">название
            <input className="input" value={spec.name} maxLength={60} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="sb-param">на чём торгую
            <select className="input" value={spec.instrumentClass} onChange={(e) => patch({ instrumentClass: e.target.value, futureGroups: [] })}>
              {['stock', 'future', 'currency'].map((k) => <option key={k} value={k}>{INSTRUMENT_CLASSES[k].label}</option>)}
            </select>
          </label>
          <label className="sb-param">направление
            <select className="input" value={spec.direction} onChange={(e) => patch({ direction: e.target.value })}>
              <option value="long">лонг</option><option value="short">шорт</option><option value="both">оба</option>
            </select>
          </label>
          <label className="sb-param">таймфрейм
            <select className="input" value={spec.timeframe} onChange={(e) => patch({ timeframe: e.target.value })}>
              {tfs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              {!tfs.some((t) => t.key === spec.timeframe) && <option value={spec.timeframe}>{TIMEFRAME_LABELS[spec.timeframe]} (нужен токен)</option>}
            </select>
          </label>
          <label className="sb-param">характер
            <select className="input" value={spec.character} onChange={(e) => patch({ character: e.target.value })}>
              {Object.entries(CHARACTERS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
            </select>
          </label>
          <label className="sb-param">горизонт
            <select className="input" value={spec.horizon} onChange={(e) => patch({ horizon: e.target.value })}>
              {Object.entries(HORIZONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        {spec.instrumentClass === 'future' && (
          <div className="sb-chips">
            <span className="sb-muted">группы фьючерсов (пусто — все):</span>
            {Object.entries(FUTURE_GROUPS).map(([k, g]) => {
              const on = (spec.futureGroups || []).includes(k);
              return (
                <button key={k} type="button" className={`sb-chipbtn${on ? ' on' : ''}`}
                  onClick={() => patch({ futureGroups: on ? spec.futureGroups.filter((x) => x !== k) : [...(spec.futureGroups || []), k] })}>{g.label}</button>
              );
            })}
          </div>
        )}
        {character && <p className="mr-note">{character.hint}</p>}
      </div>

      <div className="card sb-card">
        <div className="sb-row-title">
          <div className="section-title" style={{ margin: 0 }}>Когда вхожу</div>
          <div className="sb-mode" role="radiogroup" aria-label="Режим входа">
            <label className="mr-check"><input type="radio" checked={spec.entry.mode === 'all'} onChange={() => setEntry({ mode: 'all' })} /> все условия сразу</label>
            <label className="mr-check"><input type="radio" checked={spec.entry.mode === 'score'} onChange={() => setEntry({ mode: 'score', minScore: spec.entry.minScore || Math.max(1, Math.ceil(totalScore * 0.66)) })} /> по баллам</label>
            {spec.entry.mode === 'score' && (
              <label className="sb-param">вход от
                <input className="input sb-tiny" type="number" min={0.5} step={0.5} value={spec.entry.minScore ?? ''} onChange={(e) => setEntry({ minScore: numOr(e.target.value, 1) })} />
                <span className="sb-muted">из {totalScore}</span>
              </label>
            )}
          </div>
        </div>
        {spec.entry.mode === 'score' && (
          <p className="mr-note" style={{ marginTop: 4 }}>Каждое условие приносит свои баллы; вход, когда набралось достаточно. «Обязательно» — без этого условия не входить, сколько бы баллов ни было.</p>
        )}
        {spec.entry.conditions.map((c, i) => (
          <ConditionRow key={c.id} index={i} cond={c} spec={spec} problems={problems}
            onChange={(p) => setCond(c.id, p)} onRemove={() => removeCond(c.id)} />
        ))}
        <div className="sb-add">
          <select className="input" value="" aria-label="Добавить условие" onChange={(e) => e.target.value && addCond(e.target.value)}>
            <option value="">+ добавить условие…</option>
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {Object.entries(FEATURES).filter(([, f]) => f.group === g).map(([fid, f]) => <option key={fid} value={fid}>{f.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="sb-tol">
          <label className="sb-param">допуск «почти»: ±{spec.tolerancePct}%
            <input type="range" min={0} max={20} step={1} value={spec.tolerancePct} onChange={(e) => patch({ tolerancePct: Number(e.target.value) })} />
          </label>
          <span className="sb-muted">Сделки «почти по правилу» показываются отдельно: если у них такой же результат, правило не подогнано под одно число.</span>
        </div>
      </div>

      <div className="card sb-card">
        <div className="section-title" style={{ marginBottom: 4 }}>Как выхожу</div>
        <ExitEditor exit={spec.exit} onChange={(exit) => patch({ exit })} />
        <p className="mr-note">Выход понадобится для проверки на истории (следующий шаг). Сверка с журналом смотрит только на вход — результат там ваш настоящий.</p>
      </div>

      {(general.length > 0 || paperOnly.length > 0) && (
        <div className="card sb-card">
          {general.map((p) => <div key={p.text} className={`sb-problem sb-${p.level}`}>{p.text}</div>)}
          {paperOnly.length > 0 && (
            <div className="sb-problem sb-warn">Только для бумажной торговли: {paperOnly.join('; ')}. На истории такие условия не участвуют.</div>
          )}
        </div>
      )}

      <JournalCheck spec={spec} uid={user?.uid} token={userProfile?.tinkoffToken} valid={errors.length === 0} />

      <p className="mr-note">
        Черновик сохраняется в этом браузере. Сохранение в список стратегий, места на истории и проверка с комиссией —
        следующие шаги.
      </p>
    </>
  );
}
