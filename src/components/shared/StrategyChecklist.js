// src/components/shared/StrategyChecklist.js
//
// Renders the N/M result of evaluateStrategy() — used by the Calculator's live panel
// and (later) the Radar widget on the Dashboard. Purely a display component: the actual
// pass/fail logic lives in services/analytics/strategy.js, never here.
import React from 'react';

function ResultRow({ r }) {
  return (
    <div style={{
      display:'flex', alignItems:'flex-start', gap:8, padding:'6px 10px', borderRadius:8, fontSize:13,
      background: r.na ? 'rgba(148,163,184,0.08)' : r.passed ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
    }}>
      <span style={{color: r.na ? 'var(--text-muted)' : r.passed ? 'var(--green)' : 'var(--red)', flexShrink:0}}>{r.na ? '➖' : r.passed ? '✅' : '❌'}</span>
      <div>
        <div style={{color:'var(--text-primary)'}}>{r.label}</div>
        <div style={{color:'var(--text-muted)', fontSize:12}}>
          {r.na && !r.skippedByDirection ? 'Нет данных — не учитывается в счётчике' : r.detail}
        </div>
      </div>
    </div>
  );
}

export default function StrategyChecklist({ strategyName, result, readinessThreshold }) {
  if (!result || result.total === 0) return null;
  const { total, passed, results } = result;
  const pct = Math.round((passed / total) * 100);
  const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--red)';
  // Turns "N из M" (which the trader has to interpret themselves every time) into one
  // verdict against the threshold set on the strategy — only shown when a threshold is
  // actually configured (templates set one; a from-scratch strategy has none until the
  // trader picks one in Capital, and silently comparing against nothing would be worse
  // than not showing a verdict at all).
  const hasThreshold = readinessThreshold != null && Number.isFinite(readinessThreshold);

  // Conditions for the trade's actual direction stay in the main list, sorted so a
  // passed condition reads first — the trader's own configured criteria as the primary
  // text, not buried between ❌ noise. Conditions bound to the OTHER direction
  // (skippedByDirection) never applied to this trade in the first place — mixing them
  // into the same list made a long/short trader's checklist look half-broken with
  // stray ➖ rows for criteria that were never relevant here, so they move to their own
  // quiet, collapsed-by-default section at the bottom instead (real user report).
  const relevant = results.filter((r) => !r.skippedByDirection);
  const otherDirection = results.filter((r) => r.skippedByDirection);
  const sortedRelevant = [...relevant].sort((a, b) => {
    const rank = (r) => (r.passed ? 0 : r.na ? 2 : 1);
    return rank(a) - rank(b);
  });

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
      {hasThreshold && (
        // Plain numbers, no "Готово"/"Рано" verdict — the trader decides what a given
        // percentage means for them, the app just reports it (real user report: an
        // evaluative label overstepped what the app should be deciding for them).
        <div style={{
          display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:8, marginBottom:14,
          background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)',
        }}>
          <span style={{fontSize:13, color:'var(--text-secondary)'}}>
            Выполнено {pct}% (план: от {readinessThreshold}%)
          </span>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {sortedRelevant.map((r) => <ResultRow key={r.id} r={r} />)}
      </div>
      {otherDirection.length > 0 && (
        <details style={{marginTop:12}}>
          <summary style={{fontSize:12, color:'var(--text-muted)', cursor:'pointer'}}>
            Ещё {otherDirection.length} услов{otherDirection.length === 1 ? 'ие' : 'ий'} — для другого направления сделки, не относятся к этой
          </summary>
          <div className="flex flex-col gap-2" style={{marginTop:8, opacity:0.6}}>
            {otherDirection.map((r) => <ResultRow key={r.id} r={r} />)}
          </div>
        </details>
      )}
    </div>
  );
}
