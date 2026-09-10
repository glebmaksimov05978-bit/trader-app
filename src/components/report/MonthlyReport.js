// src/components/report/MonthlyReport.js
//
// Отчёт за месяц — страница, которую открывают раз в месяц и читают сверху вниз.
//
// Отличается от дашборда намеренно: дашборд про «сейчас» и обновляется каждый день,
// отчёт про закрытый период и не меняется задним числом. Поэтому здесь календарные
// границы, сравнение с предыдущим месяцем и итог словами — то, что трейдер может
// перечитать через полгода и понять, каким был август.
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades } from '../../services/trades';
import { getActiveStrategy } from '../../services/analytics/strategy';
import {
  buildMonthlyReport, listReportMonths, monthKeyOf, reportVerdict,
} from '../../services/analytics/monthlyReport';
import { formatCurrency } from '../../utils/calculator';
import { MIN_SAMPLE } from '../../services/analytics/insightsEngine';
import './MonthlyReport.css';

const money = (v) => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(Math.round(v)))}`;

export default function MonthlyReport() {
  const { user, userProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [monthKey, setMonthKey] = useState(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setTrades(await getUserTrades(user.uid));
      } catch {
        setTrades([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const months = useMemo(() => listReportMonths(trades), [trades]);
  // По умолчанию — самый свежий месяц, в котором что-то закрывалось. Не «текущий»:
  // если сегодня 2-е число и сделок ещё нет, пустая страница — плохой первый экран.
  const activeKey = monthKey || months[0]?.key || monthKeyOf(new Date());

  const activeStrategy = getActiveStrategy(userProfile);
  const report = useMemo(() => buildMonthlyReport({
    trades,
    monthKey: activeKey,
    profile: { ...(userProfile || {}), __activeExitRules: activeStrategy?.exitRules || null },
  }), [trades, activeKey, userProfile, activeStrategy]);

  if (loading) {
    return <div className="page"><div className="card">Загружаю сделки…</div></div>;
  }

  const s = report.stats;
  const d = report.discipline;

  return (
    <div className="page mr-page">
      <div className="page-header mr-header">
        <div>
          <h1 className="page-title">🗓 Отчёт за месяц</h1>
          <p className="page-subtitle">Итог закрытого периода — что получилось и куда смотреть дальше</p>
        </div>
        <div className="mr-header-actions">
          <select className="input mr-month" value={activeKey} onChange={(e) => setMonthKey(e.target.value)}>
            {months.length
              ? months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)
              : <option value={activeKey}>{report.label}</option>}
          </select>
          <button className="btn btn-ghost" onClick={() => window.print()}>Печать</button>
        </div>
      </div>

      {report.empty ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '40px 20px' }}>
            <div className="empty-state-icon">🗓</div>
            <div className="empty-state-title">В {report.labelIn} закрытых сделок не было</div>
            <div className="empty-state-text">Выберите другой месяц в списке справа сверху.</div>
          </div>
        </div>
      ) : (
        <>
          {/* Итог словами идёт ПЕРВЫМ: цифры ниже объясняют его, а не наоборот. */}
          <div className="card mr-verdict">{reportVerdict(report)}</div>

          <div className="grid-4 mr-kpis">
            <div className={`kpi-card ${s.totalPnl >= 0 ? 'green' : 'red'}`}>
              <div className="kpi-label">Результат месяца</div>
              <div className="kpi-value" style={{ color: s.totalPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {money(s.totalPnl)}
              </div>
              <div className="kpi-sub">
                {report.deltaPnl != null
                  ? `${report.deltaPnl >= 0 ? 'Лучше' : 'Хуже'} ${report.prevLabelGenitive} на ${formatCurrency(Math.abs(Math.round(report.deltaPnl)))}`
                  : `Сравнить не с чем — в ${report.prevLabelIn} сделок не было`}
              </div>
            </div>

            <div className="kpi-card gold">
              <div className="kpi-label">Сделок закрыто</div>
              <div className="kpi-value" style={{ color: 'var(--gold)' }}>{s.total}</div>
              <div className="kpi-sub">
                {report.prevStats ? `в ${report.prevLabelIn} — ${report.prevStats.total}` : 'первый месяц с данными'}
              </div>
            </div>

            <div className="kpi-card blue">
              <div className="kpi-label">Прибыльных</div>
              <div className="kpi-value" style={{ color: 'var(--accent-primary)' }}>{Math.round(s.winrate)}%</div>
              <div className="kpi-sub">
                {s.wins} из {s.total}
                {s.total < MIN_SAMPLE ? ' · выборка мала для вывода' : ''}
              </div>
            </div>

            <div className="kpi-card purple">
              <div className="kpi-label">Профит-фактор</div>
              <div className="kpi-value">
                {Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}
              </div>
              <div className="kpi-sub">заработано на каждый потерянный рубль</div>
            </div>
          </div>

          <div className="card mr-block">
            <div className="section-title"><div className="section-title-icon">📈</div>Форма месяца</div>
            <p className="mr-note">
              Итог месяца — одна цифра, а вот как он к ней шёл: ровный подъём и «провал с отыгрышем
              в последнюю неделю» дают одинаковый результат, но это два разных месяца.
            </p>
            <MonthCurve daily={report.daily} />
          </div>

          <div className="mr-two">
            <div className="card mr-block">
              <div className="section-title"><div className="section-title-icon">🎯</div>Дисциплина</div>
              {d.signals === 0 && d.withPostmortem === 0 ? (
                <p className="mr-note">
                  За месяц не было ни отмеченных решений по сигналам, ни разобранных сделок.
                  Решения появляются, когда вы нажимаете кнопки в уведомлениях, разбор — при
                  закрытии сделки.
                </p>
              ) : (
                <>
                  {d.signals > 0 && (
                    <>
                      <div className="stat-row">
                        <span className="stat-row-label">Сигналов пришло</span>
                        <span className="stat-row-value">{d.signals}</span>
                      </div>
                      <div className="stat-row">
                        <span className="stat-row-label">Отработано</span>
                        <span className="stat-row-value text-green">{d.acted}</span>
                      </div>
                      <div className="stat-row">
                        <span className="stat-row-label">Пропущено</span>
                        <span className="stat-row-value">{d.skipped}</span>
                      </div>
                      {d.topReasons.length > 0 && (
                        <div className="mr-reasons">
                          {d.topReasons.map((r) => (
                            <div key={r.reason} className="mr-reason">
                              <span>{r.reason}</span><span>{r.count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {d.withPostmortem > 0 && (
                    <div className="mr-vs">
                      В {d.behindCount} из {d.withPostmortem} разобранных сделок система на вашем месте
                      вышла бы лучше
                      {d.vsSystemAvg != null && (
                        <> — в среднем на <b>{Math.abs(d.vsSystemAvg).toFixed(2)} п.п.</b>
                          {d.vsSystemAvg >= 0 ? ' в вашу пользу' : ' в пользу системы'}</>
                      )}.
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="card mr-block">
              <div className="section-title"><div className="section-title-icon">🏷</div>По инструментам</div>
              <div className="table-wrapper">
                <table className="table table-compact">
                  <thead>
                    <tr><th>Тикер</th><th>Сделок</th><th>Прибыльных</th><th style={{ textAlign: 'right' }}>Итог</th></tr>
                  </thead>
                  <tbody>
                    {report.instruments.slice(0, 10).map((i) => (
                      <tr key={i.ticker}>
                        <td style={{ fontWeight: 600 }}>{i.ticker}</td>
                        <td>{i.count}</td>
                        <td>{Math.round(i.winrate)}%</td>
                        <td style={{ textAlign: 'right', color: i.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                          {money(i.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.instruments.length > 10 && (
                <div className="mr-note">Показаны 10 инструментов из {report.instruments.length}.</div>
              )}
            </div>
          </div>

          <div className="card mr-block">
            <div className="section-title"><div className="section-title-icon">💸</div>Что стоило денег в этом месяце</div>
            {report.habits.length ? (
              report.habits.map((h) => (
                <div key={h.id} className="mr-habit">
                  <div className="flex justify-between items-center">
                    <span style={{ fontWeight: 600 }}>{h.title}</span>
                    <span className="stat-row-value text-red">−{formatCurrency(Math.round(h.costRub))}</span>
                  </div>
                  <div className="mr-habit-detail">{h.detail}</div>
                  {h.confidence !== 'confirmed' && (
                    <div className="mr-habit-flag">гипотеза: n={h.sampleSize}, для уверенного вывода нужно от {MIN_SAMPLE}</div>
                  )}
                </div>
              ))
            ) : (
              <p className="mr-note">За месяц дорогих привычек не нашлось — либо их правда нет, либо сделок мало для вывода.</p>
            )}
            {report.fixedHabits.length > 0 && (
              <div className="mr-fixed">
                <b>Ушло с прошлого месяца:</b> {report.fixedHabits.join(', ').toLowerCase()}
              </div>
            )}
          </div>

          <div className="mr-two">
            <TradeCard title="Лучшая сделка" trade={report.best} good />
            <TradeCard title="Худшая сделка" trade={report.worst} />
          </div>
        </>
      )}
    </div>
  );
}

// Столбики по дням + линия накопленного итога. Своя мелкая SVG вместо recharts:
// график на 30 точек, который должен нормально печататься, — здесь библиотека дала бы
// только вес и проблемы с печатью.
function MonthCurve({ daily }) {
  const w = 100;
  const h = 34;
  const values = daily.map((d) => d.cumulative);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = (max - min) || 1;
  const y = (v) => h - ((v - min) / span) * h;
  const x = (i) => (daily.length > 1 ? (i / (daily.length - 1)) * w : w / 2);
  const path = daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(d.cumulative).toFixed(2)}`).join(' ');
  const last = values[values.length - 1] ?? 0;
  const maxBar = Math.max(1, ...daily.map((d) => Math.abs(d.pnl)));

  return (
    <div className="mr-curve">
      <div className="mr-bars">
        {daily.map((d) => (
          <div key={d.day} className="mr-bar-slot" title={`${d.day}-е: ${d.trades} сделок, ${money(d.pnl)}`}>
            <i
              className={d.pnl >= 0 ? 'up' : 'down'}
              style={{ height: `${Math.max(2, (Math.abs(d.pnl) / maxBar) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <svg className="mr-line" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="var(--border-medium)" strokeWidth="0.3" />
        <path d={path} fill="none" stroke={last >= 0 ? 'var(--green)' : 'var(--red)'} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mr-axis">
        <span>1-е</span>
        <span>накопленным итогом: <b style={{ color: last >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(last)}</b></span>
        <span>{daily.length}-е</span>
      </div>
    </div>
  );
}

function TradeCard({ title, trade, good }) {
  if (!trade) return <div className="card mr-block"><div className="section-title">{title}</div><p className="mr-note">Нет данных.</p></div>;
  return (
    <div className="card mr-block">
      <div className="section-title">
        <div className="section-title-icon">{good ? '🏆' : '🩹'}</div>{title}
      </div>
      <div className="mr-trade">
        <div>
          <div className="mr-trade-ticker">{trade.ticker}</div>
          <div className="mr-note" style={{ margin: 0 }}>
            {trade.direction === 'short' ? 'Шорт' : 'Лонг'}
            {trade.entryPrice ? ` · вход ${trade.entryPrice}` : ''}
            {trade.exitPrice ? ` → выход ${trade.exitPrice}` : ''}
          </div>
        </div>
        <div className="mr-trade-pnl" style={{ color: trade.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {money(trade.pnl || 0)}
        </div>
      </div>
      {trade.peakPct != null && trade.givebackPct != null && (
        <div className="mr-note">
          Пик по ходу сделки — {trade.peakPct.toFixed(1)}%, к выходу отдано {trade.givebackPct.toFixed(1)} п.п.
        </div>
      )}
    </div>
  );
}
