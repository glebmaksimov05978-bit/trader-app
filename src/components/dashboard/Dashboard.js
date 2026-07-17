// src/components/dashboard/Dashboard.js
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats, buildEquityCurve } from '../../services/trades';
import { computeWeeklyHabits, detectPnlByInstrumentType, MIN_SAMPLE } from '../../services/analytics/insightsEngine';
import { getRadarItems } from '../../services/radar';
import { fetchDailyCandles } from '../../services/marketData/candles';
import { computeIndicatorsAtEntry } from '../../services/analytics/indicators';
import { computePatternsAtEntry } from '../../services/analytics/patterns';
import { computeMarketContextAtEntry } from '../../services/analytics/marketContext';
import { evaluateStrategy } from '../../services/analytics/strategy';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell
} from 'recharts';
import { formatCurrency, formatNumber } from '../../utils/calculator';

const INSTRUMENT_LABELS = { stock: 'Акции', future: 'Фьючерсы', currency: 'Валюта' };

// The original plain kpi-card, restored — flipping the whole card (tried in an earlier
// round) looked broken/oversized once the back-face explanation text needed enough
// height to not clip (real user report: "дашборд теперь выглядит ужасно"). The ⓘ badge
// still exists, it just opens a small shared modal now instead of flipping the card.
function KpiCard({ className, front, onInfo }) {
  return (
    <div className={`kpi-card ${className || ''}`} style={{position:'relative'}}>
      <button
        className="kpi-info-badge"
        style={{border:'none', cursor:'pointer'}}
        onClick={(e) => { e.stopPropagation(); onInfo(); }}
      >ⓘ</button>
      {front}
    </div>
  );
}

export default function Dashboard() {
  const { user, userProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [equity, setEquity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFullReport, setShowFullReport] = useState(false);
  const [radarItems, setRadarItems] = useState([]);
  const [radarState, setRadarState] = useState({}); // itemId -> { loading, result, error }
  const [infoModal, setInfoModal] = useState(null); // { title, body } for the KPI card ⓘ modal

  useEffect(() => {
    if (!user) return;
    getUserTrades(user.uid).then((t) => {
      setTrades(t);
      const s = calcStats(t);
      setStats(s);
      setEquity(buildEquityCurve(t, userProfile?.depositSize ?? 0, userProfile?.depositSetAt));
      setLoading(false);
    });
  }, [user, userProfile]);

  useEffect(() => {
    if (!user) return;
    getRadarItems(user.uid).then(setRadarItems);
  }, [user]);

  // On-demand, not automatic — same reasoning as the Calculator's analysis button: no
  // point hitting the market for every ticker on every dashboard load.
  const checkRadarItem = async (item) => {
    setRadarState((s) => ({ ...s, [item.id]: { loading: true, result: null, error: null } }));
    try {
      const now = new Date();
      const candles = await fetchDailyCandles({
        ticker: item.ticker,
        instrumentType: item.instrumentType || 'stock',
        toDate: now,
        tinkoffToken: userProfile?.tinkoffToken,
      });
      const indicators = computeIndicatorsAtEntry(candles, now);
      const patterns = computePatternsAtEntry(candles, now);
      const marketContext = computeMarketContextAtEntry(candles, now);
      if (!indicators) throw new Error('Нет исторических свечей по этому тикеру');
      const result = userProfile?.strategy?.conditions?.length
        ? evaluateStrategy(userProfile.strategy, { indicators, patterns, marketContext, plan: {} })
        : null;
      setRadarState((s) => ({ ...s, [item.id]: { loading: false, result, error: null } }));
    } catch (e) {
      setRadarState((s) => ({ ...s, [item.id]: { loading: false, result: null, error: e.message || 'Не удалось загрузить данные' } }));
    }
  };

  const deposit = userProfile?.depositSize ?? 0;
  const lastEquity = equity[equity.length - 1]?.balance || deposit;
  const pnlTotal = lastEquity - deposit;
  const pnlPercent = ((pnlTotal / deposit) * 100).toFixed(1);

  // Last 10 trades for chart — a partially closed position already has realized P&L from
  // the closed portion, so it belongs here too (matches calcStats/buildEquityCurve).
  const recentTrades = trades
    .filter(t => (t.status === 'closed' || t.status === 'partial') && t.pnl !== undefined && t.pnl !== null)
    .slice(0, 10);
  const barData = recentTrades.reverse().map((t, i) => ({
    name: t.ticker || `#${i+1}`,
    pnl: t.pnl,
    fill: t.pnl >= 0 ? '#10b981' : '#ef4444',
  }));

  const instrumentPnl = detectPnlByInstrumentType(trades);
  const { top: weeklyHabits, all: allHabits, windowUsed, windowDays } = computeWeeklyHabits(trades, userProfile || {});

  if (loading) return (
    <div className="page" style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'60vh'}}>
      <div className="spinner" style={{width:32,height:32}}/>
    </div>
  );

  return (
    <div className="page">
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Дашборд</h1>
          <p className="page-subtitle">Добро пожаловать, {userProfile?.displayName} 👋</p>
        </div>
        <div className="badge badge-purple">
          {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </div>

      {/* KPI row — each card's ⓘ opens a small shared modal with a plain-language
          explanation + a sample-size honesty check (real user request). Flipping the
          whole card was tried and reverted — looked oversized/broken once the longer
          explanation text needed room. */}
      <div className="grid-4" style={{marginBottom: 24}}>
        <KpiCard
          className={pnlTotal >= 0 ? 'green' : 'red'}
          onInfo={() => setInfoModal({
            title: 'Баланс',
            body: <>Депозит, который вы указали в Капитале, плюс P&L сделок, закрытых <b>после</b> того
              момента. Старые сделки на это число не влияют — они уже учтены в цифре, которую вы
              ввели вручную.</>,
          })}
          front={<>
            <div className="kpi-label">Баланс</div>
            <div className="kpi-value" style={{color: pnlTotal >= 0 ? 'var(--green)' : 'var(--red)'}}>
              {formatCurrency(lastEquity)}
            </div>
            <div className="kpi-sub">{pnlTotal >= 0 ? '+' : ''}{formatCurrency(pnlTotal)} ({pnlPercent}%)</div>
          </>}
        />

        <KpiCard
          className="gold"
          onInfo={() => setInfoModal({
            title: 'Сделок всего',
            body: <>Только сделки с посчитанным результатом (P&L). Открытые позиции и сделки, где не
              хватает данных по контракту для расчёта, сюда не входят.</>,
          })}
          front={<>
            <div className="kpi-label">Сделок всего</div>
            <div className="kpi-value" style={{color:'var(--gold)'}}>{stats?.total || 0}</div>
            <div className="kpi-sub">{stats?.wins || 0} прибыльных / {stats?.losses || 0} убыточных</div>
          </>}
        />

        <KpiCard
          className="blue"
          onInfo={() => setInfoModal({
            title: 'Винрейт и профит-фактор',
            body: <>
              <b>Винрейт</b> — доля сделок в плюсе. <b>Профит-фактор</b> — сколько рублей прибыли
              приходится на рубль убытка (больше 1 — торговля в плюс за период).<br/><br/>
              {stats && stats.total < MIN_SAMPLE
                ? <>У вас {stats.total} закрытых сделок — на такой выборке оба числа ещё сильно скачут от сделки к сделке. Обычно стабилизируются примерно после {MIN_SAMPLE} сделок, осталось ~{MIN_SAMPLE - stats.total}.</>
                : <>У вас {stats?.total || 0} закрытых сделок — этого достаточно, чтобы числам можно было доверять больше, чем на первых {MIN_SAMPLE}.</>}
            </>,
          })}
          front={<>
            <div className="kpi-label">Винрейт</div>
            <div className="kpi-value" style={{color:'var(--blue)'}}>
              {stats ? `${stats.winrate.toFixed(1)}%` : '—'}
            </div>
            <div className="kpi-sub">Профит-фактор: {stats ? formatNumber(stats.profitFactor, 2) : '—'}</div>
          </>}
        />

        <KpiCard
          className={(stats?.maxDrawdown || 0) > deposit * 0.1 ? 'red' : 'purple'}
          onInfo={() => setInfoModal({
            title: 'Макс. просадка и матожидание',
            body: <>
              <b>Макс. просадка</b> — самая глубокая просадка баланса от пикового значения за всю
              историю. Это уже случившийся факт, не прогноз — за {stats?.total || 0} сделок рынок
              вас ещё мало испытывал, реальная худшая просадка впереди может быть глубже.<br/><br/>
              <b>Матожидание</b> — средний ожидаемый результат на одну сделку. Чувствительно к редким крупным сделкам (одна большая может исказить число), стабильным становится обычно примерно от {MIN_SAMPLE * 2} сделок.
            </>,
          })}
          front={<>
            <div className="kpi-label">Макс просадка</div>
            <div className="kpi-value" style={{color: (stats?.maxDrawdown||0) > deposit*0.1 ? 'var(--red)' : 'var(--accent-primary)'}}>
              {stats ? formatCurrency(stats.maxDrawdown) : '—'}
            </div>
            <div className="kpi-sub">Матожидание: {stats ? formatCurrency(Math.round(stats.expectancy)) : '—'}</div>
          </>}
        />
      </div>

      {infoModal && createPortal(
        <div className="modal-overlay" onClick={() => setInfoModal(null)}>
          <div className="modal" style={{maxWidth:420}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{infoModal.title}</h3>
              <button className="modal-close" onClick={() => setInfoModal(null)}>✕</button>
            </div>
            <div className="modal-body" style={{fontSize:13, color:'var(--text-secondary)', lineHeight:1.55}}>
              {infoModal.body}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Charts row */}
      <div className="grid-2" style={{marginBottom: 24}}>
        {/* Equity curve */}
        <div className="card">
          <div className="section-title">
            <div className="section-title-icon">📈</div>
            Кривая капитала
          </div>
          {equity.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={equity} margin={{top:5, right:10, bottom:5, left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="date" tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} />
                <YAxis tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} axisLine={false}
                  tickFormatter={(v) => `${(v/1000).toFixed(1)}k`}
                  domain={['auto', 'auto']} width={48} />
                <Tooltip
                  contentStyle={{background:'var(--bg-surface-3)', border:'1px solid var(--border-medium)', borderRadius:12, fontSize:12}}
                  formatter={(v) => [formatCurrency(v), 'Баланс']}
                />
                <Line type="monotone" dataKey="balance" stroke="var(--accent-primary)" strokeWidth={2}
                  dot={false} activeDot={{r:4, fill:'var(--accent-primary)'}} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state" style={{padding:'40px 20px'}}>
              <div className="empty-state-icon">📊</div>
              <div className="empty-state-title">Нет данных</div>
              <div className="empty-state-text">Добавьте сделки в журнал</div>
            </div>
          )}
        </div>

        {/* Recent PnL bars */}
        <div className="card">
          <div className="section-title">
            <div className="section-title-icon">💹</div>
            Последние 10 сделок
          </div>
          {barData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} margin={{top:5, right:10, bottom:5, left:0}} barSize={18} barCategoryGap="40%">
                <defs>
                  <linearGradient id="barGreen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={1}/>
                    <stop offset="100%" stopColor="#059669" stopOpacity={0.7}/>
                  </linearGradient>
                  <linearGradient id="barRed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={1}/>
                    <stop offset="100%" stopColor="#dc2626" stopOpacity={0.7}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="name" tick={{fill:'var(--text-muted)', fontSize:10}} tickLine={false} />
                <YAxis tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} axisLine={false}
                  tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} domain={['auto','auto']} width={44}/>
                <Tooltip
                  contentStyle={{background:'var(--bg-surface-3)', border:'1px solid var(--border-medium)', borderRadius:12, fontSize:12}}
                  formatter={(v) => [formatCurrency(v), 'P&L']}
                />
                <Bar dataKey="pnl" radius={[4,4,0,0]}>
                  {barData.map((entry, i) => (
                    <Cell key={i} fill={entry.pnl >= 0 ? 'url(#barGreen)' : 'url(#barRed)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state" style={{padding:'40px 20px'}}>
              <div className="empty-state-icon">📊</div>
              <div className="empty-state-title">Нет сделок</div>
            </div>
          )}
        </div>

      </div>

      {/* Radar widget — quick strategy-checklist read on watched tickers, computed live
          and only on demand (button per ticker), never automatically on page load */}
      {radarItems.length > 0 && (
        <div className="card" style={{marginBottom: 24}}>
          <div className="section-title">
            <div className="section-title-icon">📡</div>
            Радар
            {!userProfile?.strategy?.conditions?.length && (
              <span style={{fontWeight:400, fontSize:12, color:'var(--text-muted)', marginLeft:8}}>
                стратегия не настроена — <a href="/capital" style={{color:'var(--accent-primary)'}}>задать в Капитале</a>
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {radarItems.map((item) => {
              const st = radarState[item.id];
              const pct = st?.result?.total ? Math.round((st.result.passed / st.result.total) * 100) : null;
              const color = pct == null ? undefined : pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--red)';
              return (
                <div key={item.id} className="flex justify-between items-center" style={{padding:'8px 12px', background:'var(--bg-surface-2)', borderRadius:10}}>
                  <div className="flex gap-2" style={{alignItems:'center'}}>
                    <span style={{fontWeight:600}}>{item.ticker}</span>
                    {item.note && <span className="text-muted" style={{fontSize:12}}>{item.note}</span>}
                  </div>
                  {st?.loading ? (
                    <div className="spinner" style={{width:14,height:14}}/>
                  ) : st?.error ? (
                    <span style={{fontSize:12, color:'var(--red)'}}>⚠️ {st.error}</span>
                  ) : st?.result ? (
                    <span style={{fontWeight:700, color}}>{st.result.passed} из {st.result.total}</span>
                  ) : st && !st.loading && !st.error ? (
                    <span className="text-muted" style={{fontSize:12}}>
                      нужно сначала написать или выбрать готовую стратегию в разделе{' '}
                      <a href="/capital" style={{color:'var(--accent-primary)'}}>Капитал</a>
                    </span>
                  ) : (
                    <button className="btn btn-ghost btn-sm" style={{fontSize:12}} onClick={() => checkRadarItem(item)}>Проверить</button>
                  )}
                </div>
              );
            })}
          </div>
          <a href="/journal" style={{display:'inline-block', marginTop:10, fontSize:12, color:'var(--accent-primary)'}}>Все тикеры в Журнале →</a>
        </div>
      )}

      {/* Weekly habits — top money-significant conclusions from the deterministic engine */}
      <div className="card" style={{marginBottom: 24}}>
        <div className="section-title" style={{alignItems:'baseline'}}>
          <div className="section-title-icon">🎯</div>
          3 привычки недели
          <span style={{fontWeight:400, fontSize:12, color:'var(--text-muted)', marginLeft:8}}>
            {windowUsed === '30d'
              ? `за последние ${windowDays} дней`
              : `за всю историю — за ${windowDays} дней сделок пока мало`}
          </span>
        </div>
        {weeklyHabits.length > 0 ? (
          <div>
            {weeklyHabits.map((h) => (
              <div key={h.id} style={{padding:'12px 0', borderBottom:'1px solid var(--border-subtle)'}}>
                <div className="flex justify-between items-center">
                  <span style={{fontWeight:600}}>{h.title}</span>
                  <span className="stat-row-value text-red">-{formatCurrency(Math.round(h.costRub))}</span>
                </div>
                <div style={{color:'var(--text-muted)', fontSize:13, marginTop:4}}>{h.detail}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state" style={{padding:'24px 20px'}}>
            <div className="empty-state-icon">🎯</div>
            <div className="empty-state-title">
              {allHabits.some((h) => h.confidence === 'confirmed')
                ? 'Явных дорогих привычек не найдено'
                : `Пока данных мало (нужно от ${MIN_SAMPLE} сделок для точного вывода)`}
            </div>
          </div>
        )}
        <button
          className="btn-ghost"
          style={{marginTop:12, fontSize:13}}
          onClick={() => setShowFullReport((v) => !v)}
        >
          {showFullReport ? 'Скрыть полный отчёт' : 'Показать полный отчёт'}
        </button>
        {showFullReport && (
          <div style={{marginTop:12}}>
            {allHabits.map((h) => (
              <div key={h.id} style={{padding:'10px 0', borderBottom:'1px solid var(--border-subtle)'}}>
                <div className="flex justify-between items-center">
                  <span>{h.title}</span>
                  <span className="badge" style={{fontSize:11}}>
                    {h.confidence === 'confirmed' ? `n=${h.sampleSize}` : `гипотеза, n=${h.sampleSize}`}
                  </span>
                </div>
                <div style={{color:'var(--text-muted)', fontSize:13, marginTop:4}}>{h.detail}</div>
                {h.previous && (
                  <div style={{fontSize:12, marginTop:4, color: h.triggered && !h.previous.triggered ? 'var(--red)' : (!h.triggered && h.previous.triggered ? 'var(--green)' : 'var(--text-muted)')}}>
                    {h.previous.triggered
                      ? `Раньше (до этого окна): проявлялось, цена −${formatCurrency(Math.round(h.previous.costRub))}${!h.triggered ? ' — сейчас не проявляется, прогресс 👍' : ''}`
                      : h.triggered
                        ? 'Раньше не проявлялось — привычка новая, стоит обратить внимание'
                        : 'Раньше тоже не проявлялось'}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stats detail */}
      {stats && (
        <div className="grid-2">
          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">📐</div>
              Статистика
            </div>
            <div className="stat-row"><span className="stat-row-label">Средний профит</span><span className="stat-row-value text-green">{formatCurrency(Math.round(stats.avgWin))}</span></div>
            <div className="stat-row"><span className="stat-row-label">Средний убыток</span><span className="stat-row-value text-red">{formatCurrency(Math.round(stats.avgLoss))}</span></div>
            <div className="stat-row"><span className="stat-row-label">Серия побед</span><span className="stat-row-value">{stats.maxWinStreak} сделок</span></div>
            <div className="stat-row"><span className="stat-row-label">Серия убытков</span><span className="stat-row-value">{stats.maxLossStreak} сделок</span></div>
            <div className="stat-row"><span className="stat-row-label">Общий профит</span><span className="stat-row-value text-green">{formatCurrency(Math.round(stats.grossProfit))}</span></div>
            <div className="stat-row"><span className="stat-row-label">Общий убыток</span><span className="stat-row-value text-red">{formatCurrency(Math.round(stats.grossLoss))}</span></div>
          </div>

          {/* Was "Риск-контроль" here — dropped, it just duplicated the risk settings
              already editable in Капитал (real user report: felt like a copy, not new
              information). P&L by instrument type moved down here from the charts row
              instead, next to the stats it belongs with. */}
          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">🧩</div>
              P&amp;L по типам инструментов
            </div>
            {instrumentPnl.length > 0 ? (
              <div>
                {instrumentPnl.map((g) => (
                  <div className="stat-row" key={g.instrumentType}>
                    <span className="stat-row-label">
                      {INSTRUMENT_LABELS[g.instrumentType] || g.instrumentType}
                      <span style={{color:'var(--text-muted)', fontSize:12, marginLeft:6}}>
                        {g.count} сделок, винрейт {g.winrate.toFixed(0)}%
                      </span>
                    </span>
                    <span className={`stat-row-value ${g.totalPnl >= 0 ? 'text-green' : 'text-red'}`}>
                      {g.totalPnl >= 0 ? '+' : ''}{formatCurrency(Math.round(g.totalPnl))}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{padding:'40px 20px'}}>
                <div className="empty-state-icon">🧩</div>
                <div className="empty-state-title">Нет сделок</div>
              </div>
            )}
          </div>
        </div>
      )}

      {!stats && (
        <div className="card" style={{textAlign:'center', padding:'48px'}}>
          <div className="empty-state">
            <div className="empty-state-icon">🚀</div>
            <div className="empty-state-title">Начните вести журнал сделок</div>
            <div className="empty-state-text">Добавьте первую сделку, чтобы увидеть статистику на дашборде</div>
          </div>
        </div>
      )}
    </div>
  );
}
