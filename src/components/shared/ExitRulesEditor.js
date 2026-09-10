// src/components/shared/ExitRulesEditor.js
//
// Shared editor for one strategy's exit rules (see services/analytics/exitRules.js) —
// used both in Капитал (saved as part of the strategy) and on the Бэктест page
// (temporary, unsaved override for experimenting). Same shape, same UI, so a number a
// trader sees in one place means exactly the same thing in the other.
import React from 'react';
import NumberInput from './NumberInput';
import { DEFAULT_TRAIL_MIN_PEAK_ATR_MULT, DEFAULT_PROFIT_CAPTURE_SCORE_THRESHOLD, DEFAULT_TRAIL_ADVERSE_MULT } from '../../services/analytics/exitRules';

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
        {[
          ['pct', '%'], ['atr', '×ATR'], ['level', 'У уровня'],
          // Только для стопа — проверена в калибровке именно как расстояние ДО СТОПА
          // (под минимумом/над максимумом фигуры), а не как правило для тейка.
          ...(side === 'stop' ? [['structure', 'За структурой фигуры']] : []),
          ['none', 'Нет'],
        ].map(([t, label]) => (
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
      {value[`${prefix}Type`] === 'structure' && (
        <div className="flex flex-col gap-2">
          <div className="input-hint">
            Стоп ставится под минимумом (лонг) или над максимумом (шорт) той фигуры, из-за
            которой открыта сделка — там, где формация была бы отменена, а не на произвольном
            расстоянии. Проверено: реже добираются далёкие тейки (винрейт ниже), но средний
            результат сделки лучше — крупные редкие победы перекрывают частые мелкие потери.
            Работает вместе со следящим выходом «Движение выдохлось» лучше, чем с фиксированным
            тейком — ему нужен настоящий стоп-запас, а не тесный.
          </div>
          <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
            <span style={{fontSize:12, color:'var(--text-muted)'}}>Если подтверждённой фигуры нет — запасной %, от цены входа</span>
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

export default function ExitRulesEditor({ value, onChange, maxBarsEnabled, onMaxBarsEnabledChange, barUnitLabel = 'дней' }) {
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
          Выйти по времени, макс. {barUnitLabel} в сделке
        </label>
        {maxBarsEnabled && (
          <NumberInput className="input" min="1" value={value.maxBars ?? 20}
            onChange={(v) => onChange({ ...value, maxBars: Math.round(v) })} style={{width:80}} />
        )}
      </div>

      {/* Trailing "movement exhausted" exit — the one measurable win out of everything
          tested in the 2026-08 calibration. Real user request 2026-08-20: this whole
          block used to bury 4 separate controls (give-back %, arm threshold, adverse
          stop, profit-capture score) under long explanatory paragraphs, so the trader
          couldn't find "where do I turn the adverse threshold on" or "where's the
          profit system toggle" even though they existed — everything below is now one
          row per control: checkbox/label, the number, and at most one short line of
          context. Full explanations live in HANDOFF_NEXT_SESSION.md, not the UI. */}
      <div style={{padding:'10px 14px', borderRadius:10, background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)'}}>
        <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer', fontWeight:600}}>
          <input type="checkbox" checked={!!value.trailEnabled}
            onChange={(e) => onChange({ ...value, trailEnabled: e.target.checked })} />
          🌊 Следящий выход (едет за движением, не по фиксированной цене)
        </label>
        <div className="input-hint" style={{marginTop:4}}>
          Работает лучше со широким стопом (3-4%+ или «У уровня») — тесный стоп срабатывает раньше, чем следящий выход успевает включиться.
        </div>

        {value.trailEnabled && (
          <div style={{marginTop:10, display:'flex', flexDirection:'column', gap:10}}>

            <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
              <span style={{fontSize:12, width:150}}>Отдать не больше</span>
              <NumberInput className="input" min="10" max="90" step="5"
                value={value.trailGiveBackPct ?? 50}
                onChange={(v) => onChange({ ...value, trailGiveBackPct: v })} style={{width:60}} />
              <span style={{fontSize:12, color:'var(--text-muted)'}}>% от пика прибыли</span>
            </div>

            <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
              <span style={{fontSize:12, width:150}}>Включаться после хода</span>
              <NumberInput className="input" min="0.1" max="3" step="0.1"
                value={value.trailMinPeakAtrMult ?? DEFAULT_TRAIL_MIN_PEAK_ATR_MULT}
                onChange={(v) => onChange({ ...value, trailMinPeakMode: 'atr', trailMinPeakAtrMult: v })} style={{width:60}} />
              <span style={{fontSize:12, color:'var(--text-muted)'}}>× ATR(14) — рекомендуется, сам подстраивается под инструмент/таймфрейм</span>
            </div>

            {/* Was a hardcoded constant nowhere in the UI — real user report 2026-08-20:
                "я не вижу где ставить аварийный порог". DEFAULT_TRAIL_ADVERSE_MULT=2 was
                only ever a code default, never exposed. */}
            <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
              <label className="flex gap-2" style={{alignItems:'center', fontSize:12, cursor:'pointer', width:150}}>
                <input type="checkbox" checked={value.trailAdverseEnabled !== false}
                  onChange={(e) => onChange({ ...value, trailAdverseEnabled: e.target.checked })} />
                Аварийный порог
              </label>
              <NumberInput className="input" min="1" max="6" step="0.5" disabled={value.trailAdverseEnabled === false}
                value={value.trailAdverseMult ?? DEFAULT_TRAIL_ADVERSE_MULT}
                onChange={(v) => onChange({ ...value, trailAdverseMult: v })} style={{width:60}} />
              <span style={{fontSize:12, color:'var(--text-muted)'}}>× тот же ATR-шаг — закрыть, если движение против входа зашло на столько же и не отыгралось</span>
            </div>

            <label className="flex gap-2" style={{alignItems:'center', fontSize:12, cursor:'pointer'}}>
              <input type="checkbox" checked={!!value.trailPerPattern}
                onChange={(e) => onChange({ ...value, trailPerPattern: e.target.checked })} />
              Своя доля отдачи для каждой фигуры (вместо одного числа на всё)
            </label>

            {/* Profit-capture score — replaces the blunt "give back 50% of peak" rule with
                a weighted score over 27 indicators (RSI extreme, EMA13 stretch, profit>8%,
                Боллинджер10>0.85, held 15+ bars, low ADX, volume spike). See
                HANDOFF_NEXT_SESSION.md for the full calibration. */}
            <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer', fontWeight:600, marginTop:4}}>
              <input type="checkbox" checked={!!value.profitCaptureEnabled}
                onChange={(e) => onChange({ ...value, profitCaptureEnabled: e.target.checked })} />
              📈 Фиксировать прибыль по рейтингу (вместо «отдать N% от пика» выше)
            </label>
            {value.profitCaptureEnabled && (
              <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
                <span style={{fontSize:12, width:150}}>Порог очков</span>
                <NumberInput className="input" min="1" max="8" step="1"
                  value={value.profitCaptureThreshold ?? DEFAULT_PROFIT_CAPTURE_SCORE_THRESHOLD}
                  onChange={(v) => onChange({ ...value, profitCaptureThreshold: v })} style={{width:60}} />
                <span style={{fontSize:12, color:'var(--text-muted)'}}>из 8 признаков «движение выдыхается» — закрыть, когда набралось ≥</span>
              </div>
            )}

            {/* Лосс-система по счёту динамики (services/analytics/exitRules.js:
                lossNearBottomScore) — та же идея, что у профит-системы, только со
                стороны убытка: не «закрыть по стопу», а «похоже ли текущее падение на
                дно или на продолжение», по 6 признакам с 3 штрафами. Раньше в этом
                редакторе не было способа её включить вообще — только через прямую
                правку JSON профиля, что и вызывало путаницу: «конструктор не может». */}
            <label className="flex gap-2" style={{alignItems:'center', fontSize:13, cursor:'pointer', fontWeight:600, marginTop:4}}>
              <input type="checkbox" checked={value.trailLossRule === 'score'}
                onChange={(e) => onChange({
                  ...value,
                  trailLossRule: e.target.checked ? 'score' : 'breakeven',
                  // 'nearBottom' — режим, на котором калибровалась вся эта система
                  // (см. engine.js). Молчаливый дефолт движка — 'worsening', другое
                  // чтение того же счёта; ставим явно, чтобы включение здесь давало
                  // именно проверенное поведение, а не случайно другое.
                  ...(e.target.checked ? { lossScoreMode: value.lossScoreMode || 'nearBottom' } : {}),
                })} />
              📉 Оценивать убыток по рейтингу (вместо простого стопа/безубытка)
            </label>
            {value.trailLossRule === 'score' && (
              <div className="flex gap-2" style={{alignItems:'center', flexWrap:'wrap'}}>
                <span style={{fontSize:12, width:150}}>Порог очков</span>
                <NumberInput className="input" min="0" max="6" step="1"
                  value={value.lossScoreThreshold ?? 2}
                  onChange={(v) => onChange({ ...value, lossScoreThreshold: v })} style={{width:60}} />
                <span style={{fontSize:12, color:'var(--text-muted)'}}>из 6 признаков «похоже на дно» — держать, когда набралось ≥ (иначе резать)</span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
