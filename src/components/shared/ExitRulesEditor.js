// src/components/shared/ExitRulesEditor.js
//
// Shared editor for one strategy's exit rules (see services/analytics/exitRules.js) —
// used both in Капитал (saved as part of the strategy) and on the Бэктест page
// (temporary, unsaved override for experimenting). Same shape, same UI, so a number a
// trader sees in one place means exactly the same thing in the other.
import React from 'react';

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
          <input className="input" type="number" step="0.1" value={value[`${prefix}Pct`] ?? ''}
            onChange={(e) => set({ [`${prefix}Pct`]: parseFloat(e.target.value) || 0 })} style={{width:90}} />
          <span style={{fontSize:12, color:'var(--text-muted)'}}>% от цены входа</span>
        </div>
      )}
      {value[`${prefix}Type`] === 'atr' && (
        <div className="flex gap-2" style={{alignItems:'center'}}>
          <input className="input" type="number" step="0.1" value={value[`${prefix}AtrMult`] ?? ''}
            onChange={(e) => set({ [`${prefix}AtrMult`]: parseFloat(e.target.value) || 0 })} style={{width:90}} />
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
            <input className="input" type="number" step="0.1" value={value[`${prefix}LevelTolerancePct`] ?? ''}
              onChange={(e) => set({ [`${prefix}LevelTolerancePct`]: parseFloat(e.target.value) || 0 })} style={{width:70}} />
            <span style={{fontSize:12, color:'var(--text-muted)'}}>%</span>
          </div>
          <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
            <span style={{fontSize:12, color:'var(--text-muted)'}}>Если уровня нет рядом — запасной выход, % от цены входа</span>
            <input className="input" type="number" step="0.1" value={value[`${prefix}LevelFallbackPct`] ?? ''}
              onChange={(e) => set({ [`${prefix}LevelFallbackPct`]: parseFloat(e.target.value) || 0 })} style={{width:70}} />
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
      <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
        <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer'}}>
          <input type="checkbox" checked={!!maxBarsEnabled} onChange={(e) => onMaxBarsEnabledChange(e.target.checked)} />
          Выйти по времени, макс. дней в сделке
        </label>
        {maxBarsEnabled && (
          <input className="input" type="number" min="1" value={value.maxBars ?? 20}
            onChange={(e) => onChange({ ...value, maxBars: parseInt(e.target.value) || 1 })} style={{width:80}} />
        )}
      </div>
    </>
  );
}
