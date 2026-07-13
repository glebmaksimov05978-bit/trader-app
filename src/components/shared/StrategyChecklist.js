// src/components/shared/StrategyChecklist.js
//
// Renders the N/M result of evaluateStrategy() — used by the Calculator's live panel
// and (later) the Radar widget on the Dashboard. Purely a display component: the actual
// pass/fail logic lives in services/analytics/strategy.js, never here.
import React from 'react';

export default function StrategyChecklist({ strategyName, result }) {
  if (!result || result.total === 0) return null;
  const { total, passed, results } = result;
  const pct = Math.round((passed / total) * 100);
  const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--red)';

  return (
    <div className="card" style={{marginTop:16}}>
      <div className="section-title">
        <div className="section-title-icon">🎯</div>
        {strategyName || 'Моя стратегия'}
      </div>
      <div className="flex justify-between items-center" style={{marginBottom:12}}>
        <span className="text-sm text-secondary">Условий выполнено</span>
        <span style={{fontSize:20, fontWeight:800, color}}>{passed} из {total}</span>
      </div>
      <div style={{height:6, background:'var(--bg-surface-3)', borderRadius:4, overflow:'hidden', marginBottom:14}}>
        <div style={{height:'100%', width:`${pct}%`, background:color, transition:'width 0.2s'}} />
      </div>
      <div className="flex flex-col gap-2">
        {results.map((r) => (
          <div key={r.id} style={{
            display:'flex', alignItems:'flex-start', gap:8, padding:'6px 10px', borderRadius:8, fontSize:13,
            background: r.na ? 'rgba(148,163,184,0.08)' : r.passed ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
          }}>
            <span style={{color: r.na ? 'var(--text-muted)' : r.passed ? 'var(--green)' : 'var(--red)', flexShrink:0}}>{r.na ? '➖' : r.passed ? '✅' : '❌'}</span>
            <div>
              <div style={{color:'var(--text-primary)'}}>{r.label}</div>
              <div style={{color:'var(--text-muted)', fontSize:12}}>
                {r.skippedByDirection ? r.detail : r.na ? 'Нет данных — не учитывается в счётчике' : r.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
