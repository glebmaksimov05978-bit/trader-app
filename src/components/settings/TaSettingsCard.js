// src/components/settings/TaSettingsCard.js
//
// Настройка того, что показывает плашка «Технический анализ» (когда смотрим без стратегии).
// Справа/ниже — живой пример той же плашки на условных цифрах: убрал «Фибоначчи» — блок исчез из
// примера сразу, до сохранения. Так видно, что именно изменится в Калькуляторе, Журнале и
// Сопровождении.
import React, { useMemo } from 'react';
import Icon from '../shared/Icon';
import TechnicalAnalysisBlock from '../shared/TechnicalAnalysisBlock';
import { TA_SECTIONS, normalizeTaPrefs, resolveTaView, countVisible } from '../../services/analytics/taView';

// Условные цифры: нужны только чтобы показать, как выглядит каждый блок. Не рыночные данные.
const SAMPLE = {
  data: {
    indicators: {
      rsi14: 41.8,
      macdHistogram: 0.62,
      volumeRatio: 1.45,
      bollinger: { upper: 312.4, mid: 301.2, lower: 290.0, position: 'inside' },
    },
    marketContext: {
      trend: { label: 'up', slopePct: 3.2, gaugePercent: 72 },
      volatility: { label: 'normal', ratio: 1.05, gaugePercent: 50 },
    },
    patterns: {
      emaLevels: {
        ema9: { position: 'above', distancePct: 0.9, slope: 'rising', value: 303.1 },
        ema100: { position: 'above', distancePct: 2.8, slope: 'rising', value: 296.4 },
        ema200: { position: 'above', distancePct: 6.1, slope: 'rising', value: 285.9 },
      },
      supportResistance: [
        { price: 308.5, type: 'resistance', touchCount: 4 },
        { price: 295.2, type: 'support', touchCount: 3 },
      ],
      fibonacci: {
        from: { price: 270 }, to: { price: 318 },
        levels: [
          { ratio: 0.382, price: 299.7, isNearest: true },
          { ratio: 0.5, price: 294 },
          { ratio: 0.618, price: 288.3 },
        ],
      },
      candidates: [
        { pattern: 'double_bottom', status: 'forming', confidence: 68, detail: 'Две впадины около 291, перемычка 304 — пример' },
      ],
    },
  },
};

export default function TaSettingsCard({ value, onChange, onSave, saving, dirty }) {
  const prefs = useMemo(() => normalizeTaPrefs(value), [value]);
  const view = useMemo(() => resolveTaView({ prefs }), [prefs]);
  const groups = [...new Set(TA_SECTIONS.map((s) => s.group))];
  const n = countVisible(prefs);

  const setAll = (on) => onChange(Object.fromEntries(TA_SECTIONS.map((s) => [s.id, on])));

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title">
        <div className="section-title-icon"><Icon name="chart" size={15} /></div>
        Технический анализ
      </div>
      <p className="text-sm text-secondary" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        Что показывать в плашке технического анализа, когда вы смотрите инструмент без стратегии.
        Снимите галочку — блок пропадёт в примере ниже, а после сохранения — в Калькуляторе, Журнале
        и Сопровождении. Если включить в Сопровождении «по стратегии», плашка покажет только то,
        чем пользуется эта стратегия.
      </p>

      <div className="ta-set-groups">
        {groups.map((g) => (
          <div key={g} className="ta-set-group">
            <div className="ta-set-gname">{g}</div>
            {TA_SECTIONS.filter((s) => s.group === g).map((s) => (
              <label key={s.id} className="ta-set-row">
                <input
                  type="checkbox"
                  checked={prefs[s.id]}
                  onChange={(e) => onChange({ ...prefs, [s.id]: e.target.checked })}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', margin: '10px 0 14px' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setAll(true)}>Включить всё</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setAll(false)}>Выключить всё</button>
        <span className="text-xs text-muted">показано блоков: {n} из {TA_SECTIONS.length}</span>
      </div>

      <div className="ta-set-preview">
        <div className="ta-set-preview-head">Пример — так будет выглядеть плашка (цифры условные)</div>
        <TechnicalAnalysisBlock state={SAMPLE} title="Технический анализ" view={view} onRefresh={() => {}} />
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving || !dirty}>
          {saving ? 'Сохраняю…' : (dirty ? 'Сохранить выбор' : 'Сохранено')}
        </button>
      </div>
    </div>
  );
}
