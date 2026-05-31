// src/components/dashboard/Dashboard.js
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats, buildEquityCurve } from '../../services/trades';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell
} from 'recharts';
import { formatCurrency, formatNumber } from '../../utils/calculator';

// Кастомный тултип для гистограммы
const CustomBarTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const val = payload[0].value;
    return (
      <div style={{
        background: 'var(--bg-surface-3)',
        border: `1px solid ${val >= 0 ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
        borderRadius: 10,
        padding: '8px 14px',
        fontSize: 12,
        boxShadow: `0 4px 20px ${val >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}`,
      }}>
        <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
        <div style={{ color: val >= 0 ? '#10b981' : '#ef4444', fontWeight: 700, fontSize: 14 }}>
          {val >= 0 ? '+' : ''}{formatCurrency(val)}
        </div>
      </div>
    );
  }
  return null;
};

export default function Dashboard() {
  const { user, userProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [equity, setEquity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    getUserTrades(user.uid).then((t) => {
      setTrades(t);
      const s = calcStats(t);
      setStats(s);
      setEquity(buildEquityCurve(t, userProfile?.depositSize || 100000));
      setLoading(false);
    });
  }, [user, userProfile]);

  const deposit = userProfile?.depositSize || 100000;
  const lastEquity = equity[equity.length - 1]?.balance || deposit;
  const pnlTotal = lastEquity - deposit;
  const pnlPercent = ((pnlTotal / deposit) * 100).toFixed(1);

  // Last 10 trades for chart
  const recentTrades = trades.filter(t => t.status === 'closed' && t.pnl !== undefined).slice(0, 10);
  const barData = [...recentTrades].reverse().map((t, i) => ({
    name: t.ticker || `#${i+1}`,
    pnl: t.pnl,
  }));

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

      {/* KPI row */}
      <div className="grid-4" style={{marginBottom: 24}}>
        <div className={`kpi-card ${pnlTotal >= 0 ? 'green' : 'red'}`}>
          <div className="kpi-label">Баланс</div>
          <div className="kpi-value" style={{color: pnlTotal >= 0 ? 'var(--green)' : 'var(--red)'}}>
            {formatCurrency(lastEquity)}
          </div>
          <div className="kpi-sub">{pnlTotal >= 0 ? '+' : ''}{formatCurrency(pnlTotal)} ({pnlPercent}%)</div>
        </div>

        <div className="kpi-card gold">
          <div className="kpi-label">Сделок всего</div>
          <div className="kpi-value" style={{color:'var(--gold)'}}>{stats?.total || 0}</div>
          <div className="kpi-sub">{stats?.wins || 0} прибыльных / {stats?.losses || 0} убыточных</div>
        </div>

        <div className="kpi-card blue">
          <div className="kpi-label">Винрейт</div>
          <div className="kpi-value" style={{color:'var(--blue)'}}>
            {stats ? `${stats.winrate.toFixed(1)}%` : '—'}
          </div>
          <div className="kpi-sub">Profit Factor: {stats ? formatNumber(stats.profitFactor, 2) : '—'}</div>
        </div>

        <div className={`kpi-card ${(stats?.maxDrawdown || 0) > deposit * 0.1 ? 'red' : 'purple'}`}>
          <div className="kpi-label">Макс просадка</div>
          <div className="kpi-value" style={{color: (stats?.maxDrawdown||0) > deposit*0.1 ? 'var(--red)' : 'var(--accent-primary)'}}>
            {stats ? formatCurrency(stats.maxDrawdown) : '—'}
          </div>
          <div className="kpi-sub">Матожидание: {stats ? formatCurrency(Math.round(stats.expectancy)) : '—'}</div>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid-2" style={{marginBottom: 24}}>
        {/* Equity curve */}
        <div className="card">
          <div className="section-title">
            <div className="section-title-icon">📈</div>
            Кривая капитала
          </div>
          {equity.length > 1 ? (() => {
            const balances = equity.map(e => e.balance).filter(Boolean);
            const minB = Math.min(...balances);
            const maxB = Math.max(...balances);
            const padding = Math.max((maxB - minB) * 0.3, maxB * 0.005);
            const yMin = Math.floor((minB - padding) / 100) * 100;
            const yMax = Math.ceil((maxB + padding) / 100) * 100;
            return (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={equity} margin={{top:8, right:10, bottom:5, left:0}}>
                <defs>
                  <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.3}/>
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="date" tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} />
                <YAxis
                  tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} axisLine={false}
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => `${(v/1000).toFixed(1)}k`}
                  width={40}
                />
                <Tooltip
                  contentStyle={{background:'var(--bg-surface-3)', border:'1px solid var(--border-medium)', borderRadius:12, fontSize:12}}
                  formatter={(v) => [formatCurrency(v), 'Баланс']}
                />
                <Line type="monotone" dataKey="balance" stroke="#818cf8" strokeWidth={2.5}
                  dot={false} activeDot={{r:5, fill:'#818cf8', strokeWidth:2, stroke:'#fff'}} />
              </LineChart>
            </ResponsiveContainer>
            );
          })()
          ) : (
            <div className="empty-state" style={{padding:'40px 20px'}}>
              <div className="empty-state-icon">📊</div>
              <div className="empty-state-title">Нет данных</div>
              <div className="empty-state-text">Добавьте сделки в журнал</div>
            </div>
          )}
        </div>

        {/* Recent PnL bars — premium slim */}
        <div className="card">
          <div className="section-title">
            <div className="section-title-icon">💹</div>
            Последние 10 сделок
          </div>
          {barData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={barData}
                margin={{top:8, right:16, bottom:5, left:0}}
                barCategoryGap="40%"
                barSize={18}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{fill:'var(--text-muted)', fontSize:10, fontWeight:500}}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{fill:'var(--text-muted)', fontSize:11}}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => v === 0 ? '0' : `${(v/1000).toFixed(0)}k`}
                  width={32}
                />
                <Tooltip content={<CustomBarTooltip />} cursor={{fill:'rgba(255,255,255,0.04)', radius:6}} />
                <Bar dataKey="pnl" radius={[5,5,2,2]} maxBarSize={22}>
                  {barData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.pnl >= 0
                        ? 'url(#greenGrad)'
                        : 'url(#redGrad)'}
                    />
                  ))}
                </Bar>
                {/* SVG градиенты */}
                <defs>
                  <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.9}/>
                    <stop offset="100%" stopColor="#059669" stopOpacity={0.6}/>
                  </linearGradient>
                  <linearGradient id="redGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" stopOpacity={0.9}/>
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.6}/>
                  </linearGradient>
                </defs>
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

          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">⚠️</div>
              Риск-контроль
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Дневной лимит убытка</span>
              <span className="stat-row-value">{userProfile?.dailyLossLimit || 3}%</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Риск на сделку</span>
              <span className="stat-row-value">{userProfile?.maxRiskPerTrade || 1}%</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Депозит</span>
              <span className="stat-row-value">{formatCurrency(deposit)}</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Дневной лимит убытка (₽)</span>
              <span className="stat-row-value text-red">
                -{formatCurrency(Math.round(deposit * (userProfile?.dailyLossLimit || 3) / 100))}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Макс. риск на сделку (₽)</span>
              <span className="stat-row-value">
                {formatCurrency(Math.round(deposit * (userProfile?.maxRiskPerTrade || 1) / 100))}
              </span>
            </div>
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
