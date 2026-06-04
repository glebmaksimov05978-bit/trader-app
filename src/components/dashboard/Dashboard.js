// src/components/dashboard/Dashboard.js
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats, buildEquityCurve } from '../../services/trades';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar
} from 'recharts';
import { formatCurrency, formatNumber } from '../../utils/calculator';

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
      setEquity(buildEquityCurve(t, userProfile?.depositSize ?? 0));
      setLoading(false);
    });
  }, [user, userProfile]);

  const deposit = userProfile?.depositSize ?? 0;
  const lastEquity = equity[equity.length - 1]?.balance || deposit;
  const pnlTotal = lastEquity - deposit;
  const pnlPercent = ((pnlTotal / deposit) * 100).toFixed(1);

  // Last 10 trades for chart
  const recentTrades = trades.filter(t => t.status === 'closed' && t.pnl !== undefined).slice(0, 10);
  const barData = recentTrades.reverse().map((t, i) => ({
    name: t.ticker || `#${i+1}`,
    pnl: t.pnl,
    fill: t.pnl >= 0 ? '#10b981' : '#ef4444',
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
          {equity.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={equity} margin={{top:5, right:10, bottom:5, left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="date" tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} />
                <YAxis tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} axisLine={false}
                  tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
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
              <BarChart data={barData} margin={{top:5, right:10, bottom:5, left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="name" tick={{fill:'var(--text-muted)', fontSize:10}} tickLine={false} />
                <YAxis tick={{fill:'var(--text-muted)', fontSize:11}} tickLine={false} axisLine={false}
                  tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{background:'var(--bg-surface-3)', border:'1px solid var(--border-medium)', borderRadius:12, fontSize:12}}
                  formatter={(v) => [formatCurrency(v), 'P&L']}
                />
                <Bar dataKey="pnl" fill="#4f46e5" radius={[4,4,0,0]}
                  cell={(entry) => <rect fill={entry.pnl >= 0 ? '#10b981' : '#ef4444'} />}
                />
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
