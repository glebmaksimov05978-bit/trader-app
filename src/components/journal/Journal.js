// src/components/journal/Journal.js
import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, addTrade, updateTrade, deleteTrade, calcStats } from '../../services/trades';
import { formatCurrency, formatNumber } from '../../utils/calculator';
import toast from 'react-hot-toast';
import TradeModal from './TradeModal';
import './Journal.css';

const COLS = ["Тикер", "Дата", "Направление", "Вход", "Выход", "Объём", "P&L", "% деп", "Статус", ""];

export default function Journal() {
  const { user, userProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTrade, setEditTrade] = useState(null);
  const [filter, setFilter] = useState('all'); // all | long | short | open | closed
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    const t = await getUserTrades(user.uid);
    setTrades(t);
    setStats(calcStats(t));
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (data) => {
    try {
      if (editTrade) {
        await updateTrade(editTrade.id, data);
        toast.success('Сделка обновлена');
      } else {
        await addTrade(user.uid, data);
        toast.success('Сделка добавлена');
      }
      setModalOpen(false);
      setEditTrade(null);
      await load();
    } catch (e) {
      toast.error('Ошибка сохранения');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Удалить сделку?')) return;
    await deleteTrade(id);
    toast.success('Удалено');
    await load();
  };

  const openEdit = (trade) => {
    setEditTrade(trade);
    setModalOpen(true);
  };

  const filtered = trades
    .filter(t => {
      if (filter === 'long') return t.direction === 'long';
      if (filter === 'short') return t.direction === 'short';
      if (filter === 'open') return t.status === 'open';
      if (filter === 'closed') return t.status === 'closed';
      return true;
    })
    .filter(t => !search || t.ticker?.toLowerCase().includes(search.toLowerCase()));

  const fmtDate = (d) => {
    if (!d) return '—';
    const date = d.seconds ? new Date(d.seconds * 1000) : new Date(d);
    return date.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit' });
  };

  return (
    <div className="page">
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">📓 Журнал сделок</h1>
          <p className="page-subtitle">История всех ваших позиций</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditTrade(null); setModalOpen(true); }}>
          + Добавить сделку
        </button>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid-4" style={{marginBottom:24}}>
          <div className="kpi-card green">
            <div className="kpi-label">Всего сделок</div>
            <div className="kpi-value" style={{color:'var(--green)'}}>{stats.total}</div>
            <div className="kpi-sub">Открытых: {trades.filter(t=>t.status==='open').length}</div>
          </div>
          <div className="kpi-card blue">
            <div className="kpi-label">Винрейт</div>
            <div className="kpi-value" style={{color:'var(--blue)'}}>{stats.winrate.toFixed(1)}%</div>
            <div className="kpi-sub">{stats.wins}W / {stats.losses}L</div>
          </div>
          <div className={`kpi-card ${stats.totalPnl >= 0 ? 'green' : 'red'}`}>
            <div className="kpi-label">Итого P&L</div>
            <div className="kpi-value" style={{color: stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}}>
              {stats.totalPnl >= 0 ? '+' : ''}{formatCurrency(Math.round(stats.totalPnl))}
            </div>
            <div className="kpi-sub">Матожидание: {formatCurrency(Math.round(stats.expectancy))}</div>
          </div>
          <div className="kpi-card gold">
            <div className="kpi-label">Profit Factor</div>
            <div className="kpi-value" style={{color:'var(--gold)'}}>{formatNumber(stats.profitFactor, 2)}</div>
            <div className="kpi-sub">Макс. серия побед: {stats.maxWinStreak}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="journal-toolbar" style={{marginBottom:16}}>
        <div className="tabs" style={{maxWidth:400}}>
          {[['all','Все'],['open','Открытые'],['closed','Закрытые'],['long','Лонг'],['short','Шорт']].map(([v,l]) => (
            <button key={v} className={`tab ${filter===v?'active':''}`} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>
        <input
          className="input"
          style={{maxWidth:200}}
          placeholder="🔍 Поиск по тикеру"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="card" style={{padding:0}}>
        {loading ? (
          <div className="empty-state"><div className="spinner" style={{width:28,height:28}}/></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📓</div>
            <div className="empty-state-title">Нет сделок</div>
            <div className="empty-state-text">Нажмите «Добавить сделку», чтобы начать вести журнал</div>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>{COLS.map(c => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {filtered.map(trade => (
                  <tr key={trade.id}>
                    <td><span className="font-semibold">{trade.ticker || '—'}</span></td>
                    <td className="text-secondary">{fmtDate(trade.date)}</td>
                    <td>
                      <span className={`badge ${trade.direction==='long' ? 'badge-green' : 'badge-red'}`}>
                        {trade.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}
                      </span>
                    </td>
                    <td>{formatNumber(trade.entryPrice, 1)}</td>
                    <td>{trade.exitPrice ? formatNumber(trade.exitPrice, 1) : <span className="text-muted">—</span>}</td>
                    <td>{trade.volume || '—'}</td>
                    <td>
                      {trade.pnl !== undefined && trade.pnl !== null ? (
                        <span style={{color: trade.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600}}>
                          {trade.pnl >= 0 ? '+' : ''}{formatCurrency(Math.round(trade.pnl))}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      <span className={`badge ${trade.status==='open' ? 'badge-blue' : trade.pnl >= 0 ? 'badge-green' : 'badge-red'}`}>
                        {trade.status==='open' ? 'Открыта' : 'Закрыта'}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(trade)}>✏️</button>
                        <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={() => handleDelete(trade.id)}>🗑</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <TradeModal defaultDeposit={userProfile?.depositSize || 100000}
          trade={editTrade}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditTrade(null); }}
        />
      )}
    </div>
  );
}
