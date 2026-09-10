// src/components/capital/PortfolioCard.js
//
// Портфельный режим: несколько стратегий работают одновременно, у каждой своя доля
// капитала. Вся арифметика — в services/analytics/portfolio.js, здесь только выбор долей
// и показ состояния.
//
// Ребалансировки нет намеренно: приложение показывает, что доля уехала от целевой, но
// деньги между корзинами не двигает. Это управленческий учёт поверх одного брокерского
// счёта, а решение «доложить в откатную» остаётся за трейдером.
import React, { useEffect, useState } from 'react';
import { computeBaskets, getPortfolio } from '../../services/analytics/portfolio';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';
import { formatCurrency } from '../../utils/calculator';

const rub = (v) => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(Math.round(v)))}`;

export default function PortfolioCard({ userProfile, strategies, trades, onSave }) {
  const [enabled, setEnabled] = useState(false);
  const [shares, setShares] = useState({});
  const [saving, setSaving] = useState(false);

  // Профиль может приехать позже первого рендера — без этого форма показала бы пустой
  // портфель поверх сохранённого.
  useEffect(() => {
    const p = getPortfolio(userProfile);
    setEnabled(p.enabled);
    const map = {};
    for (const b of p.baskets) map[b.strategyId] = b.sharePct;
    setShares(map);
  }, [userProfile]);

  const draftPortfolio = {
    enabled,
    baskets: Object.entries(shares)
      .filter(([, v]) => Number(v) > 0)
      .map(([strategyId, sharePct]) => ({ strategyId, sharePct: Number(sharePct) })),
  };
  // Считаем по ЧЕРНОВИКУ, а не по сохранённому профилю: таблица должна отвечать на
  // вопрос «а что будет, если я поставлю 70/30», пока трейдер двигает цифры.
  const computed = computeBaskets({
    userProfile: { ...userProfile, portfolio: draftPortfolio },
    strategies,
    trades,
  });
  const sum = computed.shareTotal;
  const chosen = computed.baskets.length;

  const save = async () => {
    setSaving(true);
    await onSave(draftPortfolio);
    setSaving(false);
  };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="section-title">
        <div className="section-title-icon">🧺</div>
        Портфельный режим
      </div>
      <p className="text-sm text-secondary" style={{ marginBottom: 16 }}>
        Несколько стратегий одновременно, у каждой своя доля счёта. Без этого две стратегии
        неразличимы: одна унесла 40 тысяч, вторая вернула 45, итог «+5» — и по нему нельзя
        решить ничего. С корзинами риск считается от доли стратегии, а не от всего счёта,
        и видно, какая часть капитала работает.
      </p>

      <label className="flex items-center gap-2" style={{ marginBottom: 16, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span style={{ fontWeight: 600 }}>Включить портфельный режим</span>
      </label>

      <div className="flex flex-col gap-2" style={{ marginBottom: 16 }}>
        {strategies.map((s) => (
          <div key={s.id} className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
            <input
              type="checkbox"
              checked={Number(shares[s.id]) > 0}
              onChange={(e) => setShares((cur) => ({ ...cur, [s.id]: e.target.checked ? (cur[s.id] || 50) : 0 }))}
            />
            <span style={{ minWidth: 180, fontWeight: 600 }}>{s.name || 'Без названия'}</span>
            <span className="text-xs text-muted" style={{ minWidth: 120 }}>{kindBadge(classifyStrategy(s))}</span>
            <input
              className="input" type="number" min="0" max="100" step="5" style={{ width: 90 }}
              value={shares[s.id] ?? ''} placeholder="0"
              onChange={(e) => setShares((cur) => ({ ...cur, [s.id]: e.target.value === '' ? 0 : parseFloat(e.target.value) }))}
            />
            <span className="text-xs text-muted">% счёта</span>
          </div>
        ))}
      </div>

      {/* Доли не подгоняются под 100% молча: трейдер должен видеть, что часть счёта не
          отдана ни одной стратегии, а не узнать об этом случайно. */}
      {chosen > 0 && Math.abs(sum - 100) > 0.01 && (
        <div className="text-sm" style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-sm)',
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--gold)',
        }}>
          Сумма долей — {sum}%.{' '}
          {sum < 100
            ? `${(100 - sum).toFixed(0)}% счёта не отданы ни одной стратегии — они просто не участвуют.`
            : 'Больше 100%: корзины в сумме превышают счёт, и риск на сделку будет считаться от несуществующих денег.'}
        </div>
      )}

      {chosen > 0 && (
        <div className="table-wrapper">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Корзина</th><th style={{ textAlign: 'right' }}>Выделено</th>
                <th style={{ textAlign: 'right' }}>Результат</th><th style={{ textAlign: 'right' }}>Стало</th>
                <th style={{ textAlign: 'right' }}>Доля сейчас</th><th>Сделок</th>
              </tr>
            </thead>
            <tbody>
              {computed.baskets.map((b) => (
                <tr key={b.strategyId}>
                  <td style={{ fontWeight: 600 }}>{b.name}</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(Math.round(b.allocated))}</td>
                  <td style={{ textAlign: 'right', color: b.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{rub(b.pnl)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatCurrency(Math.round(b.balance))}</td>
                  <td style={{ textAlign: 'right' }}>
                    {b.currentSharePct.toFixed(1)}%
                    {Math.abs(b.driftPct) >= 5 && (
                      <span className="text-xs" style={{ color: 'var(--gold)' }}>
                        {' '}({b.driftPct > 0 ? '+' : ''}{b.driftPct.toFixed(0)} п.п.)
                      </span>
                    )}
                  </td>
                  <td>{b.tradeCount}</td>
                </tr>
              ))}
              {computed.unassigned.tradeCount > 0 && (
                <tr style={{ opacity: 0.7 }}>
                  <td>
                    Вне корзин{' '}
                    <span className="text-xs text-muted">заведены руками или по другой стратегии</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td style={{ textAlign: 'right', color: computed.unassigned.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {rub(computed.unassigned.pnl)}
                  </td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td>{computed.unassigned.tradeCount}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {chosen > 0 && computed.baskets.some((b) => Math.abs(b.driftPct) >= 5) && (
        <div className="text-xs text-muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Доля уехала от целевой больше чем на 5 п.п. Приложение деньги между корзинами не двигает —
          это ваше решение: доложить в отстающую, срезать выросшую или оставить как есть.
        </div>
      )}

      <div className="text-xs text-muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
        Корзина — это учёт, а не отдельный счёт у брокера. Влияет она ровно на одно: когда режим
        включён, Калькулятор считает риск на сделку от капитала корзины той стратегии, а не от
        всего депозита.
      </div>

      <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={save} disabled={saving}>
        {saving ? 'Сохранение…' : '💾 Сохранить портфель'}
      </button>
    </div>
  );
}
