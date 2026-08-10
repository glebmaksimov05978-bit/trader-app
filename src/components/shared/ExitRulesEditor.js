// src/components/shared/ExitRulesEditor.js
//
// Shared editor for one strategy's exit rules (see services/analytics/exitRules.js) —
// used both in Капитал (saved as part of the strategy) and on the Бэктест page
// (temporary, unsaved override for experimenting). Same shape, same UI, so a number a
// trader sees in one place means exactly the same thing in the other.
import React from 'react';
import NumberInput from './NumberInput';

// One stop/take rule slot — pct/atr/level/none, each revealing its own inputs. Same
// component reused for the stop side and the take side; `side` only changes labels.
function ExitSlot({ side, value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const prefix = side === 'stop' ? 'stop' : 'take';
  const sideLabel = side === 'stop' ? 'Стоп' : 'Тейк';
  return (
    <div style={{padding:'10px 14px', borderRadius:10, background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)'}}>
      <div style={{fontSize:13, fontWeight:600, marginBottom:8}}>{sideLabel}</div>
      <div className="flex gap-2" style={{marginBottom:8, flexWrap:'wrap'}}>
        {[['pct', '%'], ['atr', '×ATR'], ['level', 'У уровня'], ['none', 'Нет']].map(([t, label]) => (
          <button key={t} type="button" className={`btn btn-sm ${value[`${prefix}Type`] === t ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => set({ [`${prefix}Type`]: t })}>{label}</button>
        ))}
      </div>
      {value[`${prefix}Type`] === 'pct' && (
        <div className="flex gap-2" style={{alignItems:'center'}}>
          <NumberInput className="input" step="0.1" value={value[`${prefix}Pct`] ?? ''}
            onChange={(v) => set({ [`${prefix}Pct`]: v })} style={{width:90}} />
          <span style={{fontSize:12, color:'var(--text-muted)'}}>% от цены входа</span>
        </div>
      )}
      {value[`${prefix}Type`] === 'atr' && (
        <div className="flex gap-2" style={{alignItems:'center'}}>
          <NumberInput className="input" step="0.1" value={value[`${prefix}AtrMult`] ?? ''}
            onChange={(v) => set({ [`${prefix}AtrMult`]: v })} style={{width:90}} />
          <span style={{fontSize:12, color:'var(--text-muted)'}}>× ATR(14) на входе</span>
        </div>
      )}
      {value[`${prefix}Type`] === 'level' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
            <select className="input" style={{width:'auto'}} value={value[`${prefix}LevelSource`] || 'sr'}
              onChange={(e) => set({ [`${prefix}LevelSource`]: e.target.value })}>
              <option value="sr">Ближайший уровень S/R</option>
              <option value="ema200">EMA200</option>
            </select>
            <span style={{fontSize:12, color:'var(--text-muted)'}}>запас ±</span>
            <NumberInput className="input" step="0.1" value={value[`${prefix}LevelTolerancePct`] ?? ''}
              onChange={(v) => set({ [`${prefix}LevelTolerancePct`]: v })} style={{width:70}} />
            <span style={{fontSize:12, color:'var(--text-muted)'}}>%</span>
          </div>
          <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
            <span style={{fontSize:12, color:'var(--text-muted)'}}>Если уровня нет рядом — запасной выход, % от цены входа</span>
            <NumberInput className="input" step="0.1" value={value[`${prefix}LevelFallbackPct`] ?? ''}
              onChange={(v) => set({ [`${prefix}LevelFallbackPct`]: v })} style={{width:70}} />
          </div>
        </div>
      )}
      {value[`${prefix}Type`] === 'none' && (
        <div style={{fontSize:12, color:'var(--text-muted)'}}>Эта сторона не закрывает сделку сама по себе.</div>
      )}
    </div>
  );
}

export default function ExitRulesEditor({ value, onChange, maxBarsEnabled, onMaxBarsEnabledChange }) {
  return (
    <>
      <div className="grid-2" style={{gap:10, marginBottom:10}}>
        <ExitSlot side="stop" value={value} onChange={onChange} />
        <ExitSlot side="take" value={value} onChange={onChange} />
      </div>
      <div className="flex gap-2" style={{marginBottom:10, alignItems:'center', flexWrap:'wrap'}}>
        <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer'}}>
          <input type="checkbox" checked={!!value.onSignalLoss} onChange={(e) => onChange({ ...value, onSignalLoss: e.target.checked })} />
          Выйти, если условия стратегии перестали выполняться (сигнал пропал)
        </label>
      </div>
      <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap', marginBottom:10}}>
        <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer'}}>
          <input type="checkbox" checked={!!maxBarsEnabled} onChange={(e) => onMaxBarsEnabledChange(e.target.checked)} />
          Выйти по времени, макс. дней в сделке
        </label>
        {maxBarsEnabled && (
          <NumberInput className="input" min="1" value={value.maxBars ?? 20}
            onChange={(v) => onChange({ ...value, maxBars: Math.round(v) })} style={{width:80}} />
        )}
      </div>

      {/* Trailing "movement exhausted" exit — the one measurable win out of everything
          tested in the 2026-08 calibration (avg expectancy −0.03% → +0.08% per trade,
          profitable share 49.3% → 56.7% over ~2600 pattern instances on 6 tickers). Kept
          opt-in and explained in plain terms, since it changes exit behaviour a lot and
          every saved strategy was tuned without it. */}
      <div style={{padding:'10px 14px', borderRadius:10, background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)'}}>
        <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer', fontWeight:600}}>
          <input type="checkbox" checked={!!value.trailEnabled}
            onChange={(e) => onChange({ ...value, trailEnabled: e.target.checked })} />
          🌊 Выйти, когда движение выдохлось (следящий выход)
        </label>
        <div className="input-hint" style={{marginTop:6}}>
          Программа запоминает, докуда цена дошла в вашу пользу, и закрывает сделку, когда она
          отдаёт назад заданную долю этого пути. Смысл: фигуры угадывают направление в 76-90%
          случаев, но обычный стоп часто выбивает раньше, чем начнётся само движение.
        </div>
        {/* Real user request: the finding shouldn't live only in a chat conversation —
            show it where the trader actually flips the switch. Numbers from the 2026-08
            calibration on ~2600 real instances, 6 tickers. */}
        <div style={{
          marginTop:10, padding:'10px 12px', borderRadius:8,
          background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.25)', fontSize:12,
        }}>
          <div style={{fontWeight:600, marginBottom:4, color:'var(--green)'}}>📊 Что показала проверка на истории</div>
          <div style={{color:'var(--text-secondary)', lineHeight:1.5}}>
            На ~2600 реальных фигурах (6 тикеров, стоп 2%): доля прибыльных сделок выросла
            с 49.3% до 56.7%, средний результат сделки — с −0.03% до +0.08%. Не гарантия
            на будущее, а то, что было на этой конкретной истории.
          </div>
          <div style={{fontWeight:600, margin:'8px 0 4px', color:'var(--gold)'}}>💡 Как настроить рядом, чтобы сработало правильно</div>
          <div style={{color:'var(--text-secondary)', lineHeight:1.5}}>
            Этот выход работает, только если у сделки есть возможность «подышать» —
            если стоп выше стоит близко (например 2%), он часто сработает раньше, чем
            дойдёт очередь до следящего выхода, и вся эта настройка не будет успевать
            включиться. Стоп лучше поставить пошире — вручную (3-4%+) или «У уровня»
            за структуру фигуры. Тейк — тоже пошире или «Нет», иначе он же оборвёт
            сделку раньше, чем движение успеет остановиться само.
          </div>
        </div>
        {value.trailEnabled && (
          <>
            <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap', marginTop:10}}>
              <span style={{fontSize:12, color:'var(--text-muted)'}}>Отдать назад не больше</span>
              <NumberInput className="input" min="10" max="90" step="5"
                value={value.trailGiveBackPct ?? 50}
                onChange={(v) => onChange({ ...value, trailGiveBackPct: v })} style={{width:70}} />
              <span style={{fontSize:12, color:'var(--text-muted)'}}>% от лучшей достигнутой прибыли</span>
            </div>
            <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer', marginTop:8}}>
              <input type="checkbox" checked={!!value.trailPerPattern}
                onChange={(e) => onChange({ ...value, trailPerPattern: e.target.checked })} />
              Своя доля для каждой фигуры (вместо одного числа выше на всё)
            </label>
            <div className="input-hint" style={{marginTop:4}}>
              Без этой галочки для ЛЮБОЙ фигуры используется одно число выше (например 50%).
              С галочкой — у каждого типа своё: например, флагу восходящему даём больше простора
              (70%, он долго раскрывается), а слабой нисходящей 5-волновой структуре — меньше
              (30%, режем быстрее). Числа взяты из того, что реально сработало на истории для
              каждого типа отдельно.
            </div>
            {value.trailPerPattern && (
              <div className="input-hint" style={{marginTop:4}}>
                ⚠️ Числа подобраны на той же истории, на которой измерялись, и по 37-464 случая
                на фигуру — часть различий может быть случайностью. Это подсказка, а не
                проверенная истина: сначала сравните оба варианта на отложенном периоде.
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
