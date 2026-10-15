// src/components/report/MonthlyReport.js
//
// Отчёт за период — страница, которую открывают раз в месяц и читают сверху вниз.
//
// Три среза (реальные / бумажные / всё вместе) и два масштаба (месяц / год). Отвечает на
// вопросы: насколько хорошо я торгую, лучше ли, чем в прошлом периоде, как торгует система
// (бумажные сделки робота) и какая из стратегий лучше. Блоки про дисциплину и привычки
// относятся только к реальным сделкам и показываются в срезах «Реальные» и «Всё вместе».
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, computeLiveBalance } from '../../services/trades';
import { getPaperTrades } from '../../services/paperTrades';
import { getActiveStrategy, getStrategies } from '../../services/analytics/strategy';
import { buildStrategyComparison, comparisonNote } from '../../services/analytics/strategyCompare';
import { buildOpenRisk } from '../../services/analytics/openRisk';
import { buildDecisionJournal } from '../../services/analytics/decisionJournal';
import { buildMonthlyReport, reportVerdict } from '../../services/analytics/monthlyReport';
import { buildPeriodReport, listPeriods, SCOPES } from '../../services/analytics/periodReport';
import { buildEntryStats } from '../../services/analytics/entryStats';
import { formatCurrency, formatPercent } from '../../utils/money';
import { computeClosePnl } from '../../services/tradeClose';
import { MIN_SAMPLE } from '../../services/analytics/insightsEngine';
import './MonthlyReport.css';

// Результат одной закрывающей ступени — тем же расчётом, что и при закрытии (tradeClose.js): нужен,
// чтобы зафиксированная часть частично закрытых сделок попала в свой день и месяц.
const legPnl = (trade, leg) => computeClosePnl({ trade, exitPrice: Number(leg.price), qty: Number(leg.quantity) })?.pnl ?? NaN;

const money = (v) => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(Math.round(v)))}`;
const pfText = (v) => (v == null ? '—' : Number.isFinite(v) ? v.toFixed(2) : '∞');
const px = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : v; };
const sgn = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export default function MonthlyReport() {
  const { user, userProfile } = useAuth();
  const [real, setReal] = useState([]);
  const [paper, setPaper] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('real');
  const [type, setType] = useState('month');
  const [pickedKey, setPickedKey] = useState(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [r, p] = await Promise.all([
        getUserTrades(user.uid).catch(() => []),
        getPaperTrades(user.uid).catch(() => []),
      ]);
      setReal(r); setPaper(p); setLoading(false);
    })();
  }, [user]);

  const periods = useMemo(() => listPeriods(real, paper, type, legPnl), [real, paper, type]);
  // По умолчанию — самый свежий период, где что-то закрывалось: пустая страница в первые дни
  // нового месяца — плохой первый экран.
  const key = pickedKey && periods.some((p) => p.key === pickedKey) ? pickedKey : periods[0]?.key;

  const rep = useMemo(() => (key ? buildPeriodReport({ realTrades: real, paperTrades: paper, scope, type, key, legPnl }) : null),
    [real, paper, scope, type, key]);

  // Классический месячный отчёт (итог словами, дисциплина, привычки) — только по реальным сделкам.
  const activeStrategy = getActiveStrategy(userProfile);
  const classic = useMemo(() => {
    if (type !== 'month' || scope === 'paper' || !key) return null;
    return buildMonthlyReport({ trades: real, monthKey: key, profile: { ...(userProfile || {}), __activeExitRules: activeStrategy?.exitRules || null } });
  }, [real, type, scope, key, userProfile, activeStrategy]);

  // Сравнение стратегий: строится по сделкам выбранного среза за период. Бумажные и реальные сделки
  // каждой стратегии считаются вместе — это одна стратегия, а источник виден в срезе «Всё вместе».
  const strategies = useMemo(() => getStrategies(userProfile), [userProfile]);
  const comparison = useMemo(() => {
    if (!rep || rep.empty) return null;
    return buildStrategyComparison({
      items: rep.items, paperTrades: paper, realTrades: real, strategies, type, key,
    });
  }, [rep, paper, real, strategies, type, key]);

  // Журнал решений: что вы делали с бумажными сигналами и чего это стоило.
  const journal = useMemo(() => (key ? buildDecisionJournal({ paperTrades: paper, realTrades: real, type, key }) : null),
    [paper, real, type, key]);

  // Общий риск открытых позиций — на сейчас, а не за период: он про то, что в рынке прямо сейчас.
  const openRisk = useMemo(() => buildOpenRisk({
    trades: real, paper,
    deposit: computeLiveBalance(real, userProfile?.depositSize, userProfile?.depositSetAt),
    dailyLossLimitPct: Number(userProfile?.dailyLossLimit) || null,
    maxRiskPerTradePct: Number(userProfile?.maxRiskPerTrade) || null,
  }), [real, paper, userProfile]);

  const entryStats = useMemo(() => {
    if (!rep || scope === 'paper') return null;
    return buildEntryStats(rep.items.filter((x) => x.src === 'real').map((x) => x.raw));
  }, [rep, scope]);

  if (loading) return <div className="page"><div className="card">Загружаю сделки…</div></div>;

  return (
    <div className="page mr-page">
      <div className="page-header mr-header">
        <div>
          <h1 className="page-title">Отчёт</h1>
          <p className="page-subtitle">Как идёт торговля — относительно прошлого периода, системы и стратегий</p>
        </div>
        <div className="mr-header-actions">
          <button className="btn btn-ghost" onClick={() => window.print()}>Печать</button>
        </div>
      </div>

      <div className="mr-controls">
        <div className="mr-seg" role="tablist" aria-label="Срез">
          {SCOPES.map((s) => (
            <button key={s.id} className={scope === s.id ? 'on' : ''} onClick={() => setScope(s.id)}>{s.label}</button>
          ))}
        </div>
        <div className="mr-seg">
          <button className={type === 'month' ? 'on' : ''} onClick={() => { setType('month'); setPickedKey(null); }}>Месяц</button>
          <button className={type === 'year' ? 'on' : ''} onClick={() => { setType('year'); setPickedKey(null); }}>Год</button>
        </div>
        <select className="input mr-month" value={key || ''} onChange={(e) => setPickedKey(e.target.value)} disabled={!periods.length}>
          {periods.length ? periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>) : <option>нет данных</option>}
        </select>
      </div>

      <OpenRiskCard risk={openRisk} />

      {!rep || rep.empty ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '40px 20px' }}>
            <div className="empty-state-title">В выбранном периоде закрытых сделок нет</div>
            <div className="empty-state-text">
              {scope === 'paper' ? 'Бумажные сделки появляются, когда робот открыл и закрыл хотя бы одну.' : 'Выберите другой период или срез.'}
            </div>
          </div>
        </div>
      ) : (
        <>
          {classic && !classic.empty && type === 'month' && scope === 'real'
            ? <div className="card mr-verdict">{reportVerdict(classic)}</div>
            : <div className="card mr-verdict">{summaryLine(rep)}</div>}

          <KpiRow rep={rep} />

          <div className="card mr-block">
            <div className="section-title">Накопленный результат</div>
            <p className="mr-note" style={{ marginTop: 0, marginBottom: 6 }}>
              Сплошная линия — {rep.label.toLowerCase()}, пунктир — {rep.prevLabel.toLowerCase()} для сравнения.
            </p>
            <EquityChart curve={rep.curve} prev={rep.prevCurve} type={type} />
          </div>

          <div className="mr-two">
            <VersusCard rep={rep} />
            <StrategyCard rep={rep} />
          </div>

          <ComparisonCard cmp={comparison} label={rep.label} />

          <DecisionCard j={journal} label={rep.label} />

          <div className="mr-two">
            <div className="card mr-block">
              <div className="section-title">По инструментам</div>
              <div className="table-wrapper">
                <table className="table table-compact">
                  <thead><tr><th>Тикер</th><th>Сделок</th><th>Прибыльных</th><th style={{ textAlign: 'right' }}>Итог</th></tr></thead>
                  <tbody>
                    {rep.byInstrument.slice(0, 10).map((i) => (
                      <tr key={i.label}>
                        <td style={{ fontWeight: 600 }}>{i.label}</td><td>{i.count}</td><td>{Math.round(i.winrate)}%</td>
                        <td className={`mr-num ${sgn(i.pnl)}`}>{money(i.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rep.byInstrument.length > 10 && <div className="mr-note">Показаны 10 из {rep.byInstrument.length}.</div>}
            </div>
            <div className="mr-two-col">
              <TradeCard title="Лучшая сделка" item={rep.stats.best} />
              <TradeCard title="Худшая сделка" item={rep.stats.worst} />
            </div>
          </div>

          {entryStats && entryStats.groups.length > 0 && (
            <div className="card mr-block">
              <div className="section-title">Мои входы</div>
              <p className="mr-note" style={{ marginTop: 0 }}>
                Как отработали ваши реальные входы: направление, день недели, время суток (по Москве), срок удержания.
                {entryStats.total < MIN_SAMPLE ? ` Сделок ${entryStats.total} — для уверенных выводов нужно от ${MIN_SAMPLE}, читайте как наблюдение.` : ''}
              </p>
              <div className="mr-entry-grid">
                {entryStats.groups.map((g) => (
                  <div key={g.id}>
                    <div className="mr-entry-title">{g.title}</div>
                    <table className="table table-compact">
                      <thead><tr><th></th><th>Сделок</th><th>Прибыльных</th><th style={{ textAlign: 'right' }}>Итог</th></tr></thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={r.label} style={r.count < 3 ? { opacity: 0.6 } : undefined}>
                            <td style={{ fontWeight: 600 }}>{r.label.replace(/^\d\) /, '')}</td><td>{r.count}</td><td>{Math.round(r.winrate)}%</td>
                            <td className={`mr-num ${sgn(r.pnl)}`}>{money(r.pnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </div>
          )}

          {classic && !classic.empty && (
            <>
              <div className="card mr-block">
                <div className="section-title">Дисциплина (реальные сделки)</div>
                <Discipline d={classic.discipline} />
              </div>
              <div className="card mr-block">
                <div className="section-title">Что стоило денег</div>
                {classic.habits.length ? classic.habits.map((h) => (
                  <div key={h.id} className="mr-habit">
                    <div className="flex justify-between items-center">
                      <span style={{ fontWeight: 600 }}>{h.title}</span>
                      <span className="mr-num down">−{formatCurrency(Math.round(h.costRub))}</span>
                    </div>
                    <div className="mr-habit-detail">{h.detail}</div>
                    {h.confidence !== 'confirmed' && <div className="mr-habit-flag">гипотеза: n={h.sampleSize}, для уверенного вывода нужно от {MIN_SAMPLE}</div>}
                  </div>
                )) : <p className="mr-note" style={{ marginTop: 0 }}>За период дорогих привычек не нашлось — либо их нет, либо сделок мало для вывода.</p>}
                {classic.fixedHabits.length > 0 && <div className="mr-fixed"><b>Ушло с прошлого месяца:</b> {classic.fixedHabits.join(', ').toLowerCase()}</div>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------- общий риск открытых позиций ----------
function OpenRiskCard({ risk }) {
  const t = risk.total;
  if (!t.count && !risk.paper.count) return null;
  const pct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
  return (
    <div className="card mr-block mr-risk">
      <div className="section-title">Риск открытых позиций сейчас</div>
      {t.count > 0 ? (
        <>
          <div className="mr-risk-top">
            <div>
              <div className="mr-kpi-label">Если сработают все стопы</div>
              <div className="mr-kpi-value down">−{formatCurrency(Math.round(t.riskRub))}</div>
              <div className="mr-kpi-sub">{pct(t.riskPct)} депозита · позиций {t.count}</div>
            </div>
            <div>
              <div className="mr-kpi-label">В рынке на сумму</div>
              <div className="mr-kpi-value">{formatCurrency(Math.round(t.notional))}</div>
              <div className="mr-kpi-sub">{pct(t.exposurePct)} депозита (с плечом может быть больше 100%)</div>
            </div>
          </div>
          {risk.byTicker.length > 0 && (
            <table className="table table-compact" style={{ marginTop: 10 }}>
              <thead><tr><th>Инструмент</th><th>Позиций</th><th>Стратегии</th><th style={{ textAlign: 'right' }}>Риск</th></tr></thead>
              <tbody>
                {risk.byTicker.map((r) => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 600 }}>{r.ticker}</td><td>{r.count}</td>
                    <td>{r.strategies.join(', ')}</td>
                    <td className="mr-num down">−{formatCurrency(Math.round(r.riskRub))}{r.riskPct != null ? ` · ${r.riskPct.toFixed(1)}%` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {risk.warnings.map((w) => <div key={w.code + w.text} className="mr-risk-warn">{w.text}</div>)}
        </>
      ) : (
        <p className="mr-note" style={{ marginTop: 0 }}>Реальных открытых позиций нет.</p>
      )}
      {risk.paper.count > 0 && (
        <p className="mr-note">Бумажных открыто {risk.paper.count}: условный риск {formatCurrency(Math.round(risk.paper.riskRub))} — в реальный риск не входит.</p>
      )}
    </div>
  );
}

// ---------- журнал решений ----------
function DecisionCard({ j, label }) {
  if (!j || !j.hasAnything) return null;
  const avgTxt = (b) => (b.count ? `${money(b.avg)} за сделку · ${Math.round(b.winrate)}% прибыльных` : '—');
  return (
    <div className="card mr-block">
      <div className="section-title">Журнал решений</div>
      {j.signals > 0 ? (
        <>
          <p className="mr-note" style={{ marginTop: 0 }}>
            Сигналов за {label.toLowerCase()}: <b>{j.signals}</b>. Отмечено вами или по данным Т-Банка: <b>{j.marked}</b>
            {j.unmarkedSignals > 0 && <>, без отметки: <b>{j.unmarkedSignals}</b></>}
            {j.waiting > 0 && <> · сейчас ждут решения: <b>{j.waiting}</b></>}.
          </p>
          <table className="table table-compact">
            <thead><tr><th>Что вы сделали</th><th>Закрытых сигналов</th><th>Итог системы по ним</th><th>В среднем</th></tr></thead>
            <tbody>
              <tr><td style={{ fontWeight: 600 }}>Вошли</td><td>{j.followed.count}</td>
                <td className={`mr-num ${sgn(j.followed.pnl)}`}>{j.followed.count ? money(j.followed.pnl) : '—'}</td><td>{avgTxt(j.followed)}</td></tr>
              <tr><td style={{ fontWeight: 600 }}>Пропустили</td><td>{j.skipped.count}</td>
                <td className={`mr-num ${sgn(j.skipped.pnl)}`}>{j.skipped.count ? money(j.skipped.pnl) : '—'}</td><td>{avgTxt(j.skipped)}</td></tr>
              <tr><td style={{ fontWeight: 600 }}>Без отметки</td><td>{j.unmarked.count}</td>
                <td className={`mr-num ${sgn(j.unmarked.pnl)}`}>{j.unmarked.count ? money(j.unmarked.pnl) : '—'}</td><td>{avgTxt(j.unmarked)}</td></tr>
            </tbody>
          </table>
          <p className="mr-note"><b>{j.verdict.enough ? 'Вывод: ' : ''}</b>{j.verdict.text}</p>
          {j.reasons.length > 0 && (
            <>
              <div className="mr-cmp-sub">Причины пропусков</div>
              <table className="table table-compact">
                <thead><tr><th>Причина</th><th>Сигналов</th><th style={{ textAlign: 'right' }}>Чего стоил пропуск</th></tr></thead>
                <tbody>
                  {j.reasons.map((r) => (
                    <tr key={r.reason}><td style={{ fontWeight: 600 }}>{r.reason}</td><td>{r.count}</td>
                      <td className={`mr-num ${sgn(-r.pnl)}`}>{r.pnl > 0 ? `упущено ${money(r.pnl)}` : r.pnl < 0 ? `сэкономлено ${money(-r.pnl)}` : '—'}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="mr-note">Цифры — результат системы по пропущенным сигналам, а не ваш: вы этих денег не получили и не потеряли.</p>
            </>
          )}
        </>
      ) : <p className="mr-note" style={{ marginTop: 0 }}>За период не было бумажных сигналов.</p>}

      {j.entryKinds.length > 0 && (
        <>
          <div className="mr-cmp-sub">Мои реальные входы: по сигналу или по своему решению</div>
          <table className="table table-compact">
            <thead><tr><th>Причина входа</th><th>Сделок</th><th>Прибыльных</th><th style={{ textAlign: 'right' }}>Итог</th></tr></thead>
            <tbody>
              {j.entryKinds.map((k) => (
                <tr key={k.kind}><td style={{ fontWeight: 600 }}>{k.label}</td><td>{k.count}</td><td>{Math.round(k.winrate)}%</td>
                  <td className={`mr-num ${sgn(k.pnl)}`}>{money(k.pnl)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------- сравнение стратегий ----------
const fmtPct1 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function ComparisonCard({ cmp, label }) {
  if (!cmp || !cmp.hasAny) return null;
  const holdText = (d) => (d == null ? '—' : d < 1 ? `${Math.max(1, Math.round(d * 24))} ч` : `${Math.round(d * 10) / 10} дн`);
  const table = (rows, best = null) => {
    const b = (metric, key) => (best && best[metric] === key ? 'mr-best' : '');
    return (
      <div className="table-wrapper">
        <table className="table table-compact mr-cmp">
          <thead>
            <tr>
              <th>Стратегия</th><th>Сигналов</th><th>Сделок</th><th>Прибыльных</th>
              <th style={{ textAlign: 'right' }}>Итог</th><th>Профит-фактор</th><th>Срок</th>
              {best && <th>Забрано хода</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div className="mr-cmp-cap">{r.caption || 'горизонт не задан'}{r.openNow ? ` · в рынке ${r.openNow}` : ''}</div>
                </td>
                <td>{r.signals}</td>
                <td>{r.stats.total}</td>
                <td className={b('winrate', r.key)}>{r.stats.total ? `${Math.round(r.stats.winrate)}%` : '—'}</td>
                <td className={`mr-num ${sgn(r.stats.pnl)} ${b('pnl', r.key)}`}>{money(r.stats.pnl)}</td>
                <td className={b('profitFactor', r.key)}>{pfText(r.stats.profitFactor)}</td>
                <td>{holdText(r.avgHoldDays)}</td>
                {best && <td className={b('capture', r.key)}>{r.capture ? `${fmtPct1(r.capture.ratio)} (${r.capture.n})` : 'мало данных'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  const rest = cmp.clusters.filter((c) => !c.comparable);
  return (
    <div className="card mr-block">
      <div className="section-title">Сравнение стратегий</div>
      <p className="mr-note" style={{ marginTop: 0 }}>{comparisonNote(cmp)}</p>

      {cmp.comparableClusters.map((c) => (
        <div key={c.classKey} className="mr-cmp-cluster">
          <div className="mr-cmp-head">Одного класса: {c.caption} <span>— сравниваются напрямую</span></div>
          {table(c.rows, c.best)}
          <p className="mr-note">
            «Забрано хода» — какую долю максимального движения цены за время сделки стратегия превратила в результат;
            в скобках — по скольким сделкам посчитано (нужно от 3). Лучшее значение в строке выделено.
          </p>
          {c.shared.length > 0 && (
            <>
              <div className="mr-cmp-sub">Общие инструменты</div>
              <table className="table table-compact">
                <thead><tr><th>Инструмент</th>{c.rows.map((r) => <th key={r.key} style={{ textAlign: 'right' }}>{r.name}</th>)}</tr></thead>
                <tbody>
                  {c.shared.map((sh) => (
                    <tr key={sh.ticker}>
                      <td style={{ fontWeight: 600 }}>{sh.ticker}</td>
                      {c.rows.map((r) => {
                        const cell = sh.rows.find((x) => x.key === r.key);
                        return <td key={r.key} className={`mr-num ${cell ? sgn(cell.pnl) : ''}`}>{cell ? `${money(cell.pnl)} (${cell.count})` : '—'}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ))}

      {rest.length > 0 && (
        <div className="mr-cmp-cluster">
          <div className="mr-cmp-head">{cmp.comparableClusters.length ? 'Остальные' : 'Стратегии'} — только факты за {label.toLowerCase()}</div>
          {table(rest.flatMap((c) => c.rows))}
        </div>
      )}
    </div>
  );
}

function summaryLine(rep) {
  const s = rep.stats;
  const parts = [`${rep.label}: ${s.total} закрытых, результат ${money(s.pnl)}, ${Math.round(s.winrate)}% прибыльных.`];
  if (rep.delta.hasPrev) parts.push(`Против ${rep.prevLabelGen} — ${rep.delta.pnl >= 0 ? 'лучше' : 'хуже'} на ${formatCurrency(Math.abs(Math.round(rep.delta.pnl)))}.`);
  const { real, paper } = rep.versus;
  if (rep.scope !== 'paper' && real.total && paper.total) {
    const better = real.avg >= paper.avg ? 'вы' : 'система';
    parts.push(`В среднем за сделку лучше ${better}: ${money(real.avg)} против ${money(paper.avg)}.`);
  }
  return parts.join(' ');
}

function Delta({ value, suffix = '', invert = false }) {
  if (value == null || !Number.isFinite(value)) return null;
  const good = invert ? value < 0 : value > 0;
  if (Math.round(value) === 0) return <span className="mr-delta">без изменений</span>;
  return <span className={`mr-delta ${good ? 'up' : 'down'}`}>{value > 0 ? '▲' : '▼'} {formatCurrency(Math.abs(Math.round(value)))}{suffix}</span>;
}

function KpiRow({ rep }) {
  const s = rep.stats, d = rep.delta;
  const cards = [
    { label: 'Результат', value: money(s.pnl), cls: sgn(s.pnl),
      sub: (
        <>
          {d.hasPrev ? <><Delta value={d.pnl} /> к {rep.prevLabel.toLowerCase()}</> : 'прошлый период без сделок'}
          {s.realizedOpen !== 0 && (
            <div title="Часть прибыли, зафиксированная по сделкам, которые ещё открыты. Входит в результат, но не в число сделок.">
              в т.ч. зафиксировано по открытым: <b className={sgn(s.realizedOpen)}>{money(s.realizedOpen)}</b>
            </div>
          )}
        </>
      ) },
    { label: 'Сделок', value: s.total, sub: d.hasPrev ? `в ${rep.prevLabelIn} — ${rep.prevStats.total}` : '—' },
    { label: 'Прибыльных', value: `${Math.round(s.winrate)}%`, sub: d.winrate != null ? `${d.winrate >= 0 ? '+' : '−'}${Math.abs(d.winrate).toFixed(0)} п.п. к прошлому` : `${s.wins} из ${s.total}` },
    { label: 'Профит-фактор', value: pfText(s.profitFactor), sub: 'заработано на рубль потерь' },
    { label: 'Средняя сделка', value: money(s.avg), cls: sgn(s.avg), sub: `выигрыш ${money(s.avgWin)}, проигрыш ${money(s.avgLoss)}` },
    { label: 'Макс. просадка', value: `−${formatCurrency(Math.round(s.maxDrawdown))}`, cls: s.maxDrawdown > 0 ? 'down' : '', sub: 'от пика накопленного итога' },
  ];
  return (
    <div className="mr-kpis">
      {cards.map((c) => (
        <div key={c.label} className="mr-kpi">
          <div className="mr-kpi-label">{c.label}</div>
          <div className={`mr-kpi-value ${c.cls || ''}`}>{c.value}</div>
          <div className="mr-kpi-sub">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// Накопленная кривая: линия периода + пунктир прошлого, нулевая линия, подписи шкалы. Свои
// SVG вместо библиотеки: график на 12–31 точку, который должен нормально печататься.
function EquityChart({ curve, prev, type }) {
  const W = 760, H = 220, L = 54, R = 12, T = 10, B = 24;
  const series = curve.map((c) => c.cumulative);
  const prevS = (prev || []).map((c) => c.cumulative);
  const all = [0, ...series, ...prevS];
  let max = Math.max(...all), min = Math.min(...all);
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.08; max += pad; min -= pad;
  const x = (i, n) => L + (n > 1 ? (i / (n - 1)) * (W - L - R) : (W - L - R) / 2);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const path = (arr, n = arr.length) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  // Линия периода рисуется только до последнего дня со сделками — дальше «плато» выглядело бы как факт.
  let lastIdx = series.length - 1;
  while (lastIdx > 0 && curve[lastIdx].trades === 0) lastIdx -= 1;
  const own = series.slice(0, lastIdx + 1);
  const end = own[own.length - 1] ?? 0;
  const color = end >= 0 ? 'var(--green)' : 'var(--red)';
  const ticks = [max - pad, 0, min + pad].map((v) => Math.round(v));
  const xLabels = type === 'year' ? [0, 3, 6, 9, 11] : [0, 7, 14, 21, series.length - 1];
  const area = `${path(own, series.length)} L${x(own.length - 1, series.length).toFixed(1)},${y(0).toFixed(1)} L${x(0, series.length).toFixed(1)},${y(0).toFixed(1)} Z`;
  return (
    <div className="mr-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Накопленный результат">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'zero' : 'grid'} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{t.toLocaleString('ru-RU')}</text>
          </g>
        ))}
        {prevS.length > 0 && <path d={path(prevS)} className="prev" />}
        <path d={area} fill={color} opacity="0.10" />
        <path d={path(own, series.length)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {own.length > 0 && <circle cx={x(own.length - 1, series.length)} cy={y(end)} r="3.5" fill={color} />}
        {xLabels.filter((i) => curve[i]).map((i) => (
          <text key={i} x={x(i, series.length)} y={H - 6} textAnchor="middle" className="axis">{curve[i].label}</text>
        ))}
      </svg>
      <div className="mr-chart-end">Итог на конец: <b className={end >= 0 ? 'up' : 'down'}>{money(end)}</b></div>
    </div>
  );
}

function VersusCard({ rep }) {
  const { real, paper } = rep.versus;
  const row = (label, f) => (
    <tr><td className="mr-lbl">{label}</td><td className="mr-v">{real.total ? f(real) : '—'}</td><td className="mr-v">{paper.total ? f(paper) : '—'}</td></tr>
  );
  const bothSides = real.total && paper.total;
  return (
    <div className="card mr-block">
      <div className="section-title">Я против системы</div>
      <p className="mr-note" style={{ marginTop: 0 }}>Реальные сделки и бумажные сделки робота за {rep.label.toLowerCase()} — рядом.</p>
      <table className="table table-compact mr-versus">
        <thead><tr><th></th><th className="mr-v">Я (реальные)</th><th className="mr-v">Система (бумага)</th></tr></thead>
        <tbody>
          {row('Сделок', (s) => s.total)}
          {row('Результат', (s) => <span className={`mr-num ${sgn(s.pnl)}`}>{money(s.pnl)}</span>)}
          {row('Прибыльных', (s) => `${Math.round(s.winrate)}%`)}
          {row('Средняя сделка', (s) => <span className={`mr-num ${sgn(s.avg)}`}>{money(s.avg)}</span>)}
          {row('Профит-фактор', (s) => pfText(s.profitFactor))}
          {row('Макс. просадка', (s) => `−${formatCurrency(Math.round(s.maxDrawdown))}`)}
        </tbody>
      </table>
      <p className="mr-note">
        {bothSides
          ? `По средней сделке впереди ${real.avg >= paper.avg ? 'вы' : 'система'}. Суммы не совсем сопоставимы: у бумажных объём считается по правилам риска, у реальных — как вы сами решили.`
          : 'Сравнение появится, когда за период есть и реальные, и бумажные закрытые сделки.'}
      </p>
    </div>
  );
}

function StrategyCard({ rep }) {
  const rows = rep.byStrategy;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
  return (
    <div className="card mr-block">
      <div className="section-title">Стратегии</div>
      {rows.length <= 1 && <p className="mr-note" style={{ marginTop: 0 }}>
        {rows.length ? 'За период торговала одна стратегия.' : 'Нет данных.'} Чтобы сравнивать несколько, отметьте их в Настройках → Бумажные сделки.
      </p>}
      <div className="mr-strats">
        {rows.map((r) => (
          <div key={r.label} className="mr-strat">
            <div className="mr-strat-top">
              <span className="mr-strat-name">{r.label}</span>
              <span className={`mr-num ${sgn(r.pnl)}`}>{money(r.pnl)}</span>
            </div>
            <div className="mr-strat-bar"><i className={sgn(r.pnl)} style={{ width: `${Math.max(3, (Math.abs(r.pnl) / maxAbs) * 100)}%` }} /></div>
            <div className="mr-strat-sub">{r.count} сделок · {Math.round(r.winrate)}% прибыльных · профит-фактор {pfText(r.profitFactor)} · средняя {money(r.avg)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Discipline({ d }) {
  if (d.signals === 0 && d.withPostmortem === 0) {
    return <p className="mr-note" style={{ marginTop: 0 }}>За период не было отмеченных решений по сигналам и разобранных сделок. Решения появляются, когда вы нажимаете кнопки в уведомлениях, разбор — при закрытии сделки.</p>;
  }
  return (
    <>
      {d.signals > 0 && (
        <>
          <div className="stat-row"><span className="stat-row-label">Сигналов пришло</span><span className="stat-row-value">{d.signals}</span></div>
          <div className="stat-row"><span className="stat-row-label">Отработано</span><span className="stat-row-value text-green">{d.acted}</span></div>
          <div className="stat-row"><span className="stat-row-label">Пропущено</span><span className="stat-row-value">{d.skipped}</span></div>
          {d.topReasons.length > 0 && <div className="mr-reasons">{d.topReasons.map((r) => <div key={r.reason} className="mr-reason"><span>{r.reason}</span><span>{r.count}</span></div>)}</div>}
        </>
      )}
      {d.withPostmortem > 0 && (
        <div className="mr-vs">
          В {d.behindCount} из {d.withPostmortem} разобранных сделок система на вашем месте вышла бы лучше
          {d.vsSystemAvg != null && <> — в среднем на <b>{Math.abs(d.vsSystemAvg).toFixed(2)} п.п.</b>{d.vsSystemAvg >= 0 ? ' в вашу пользу' : ' в пользу системы'}</>}.
        </div>
      )}
    </>
  );
}

function TradeCard({ title, item }) {
  if (!item) return <div className="card mr-block"><div className="section-title">{title}</div><p className="mr-note" style={{ marginTop: 0 }}>Нет данных.</p></div>;
  const t = item.raw || {};
  return (
    <div className="card mr-block">
      <div className="section-title">{title}</div>
      <div className="mr-trade">
        <div>
          <div className="mr-trade-ticker">{item.ticker} <span className="mr-src">{item.src === 'paper' ? 'бумага' : 'реал'}</span></div>
          <div className="mr-note" style={{ margin: 0 }}>
            {item.direction === 'short' ? 'Шорт' : 'Лонг'}{t.entryPrice ? ` · вход ${px(t.entryPrice)}` : ''}{t.exitPrice ? ` → выход ${px(t.exitPrice)}` : ''}
          </div>
        </div>
        <div className={`mr-trade-pnl mr-num ${sgn(item.pnl)}`}>{money(item.pnl)}</div>
      </div>
    </div>
  );
}
