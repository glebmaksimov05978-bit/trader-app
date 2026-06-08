// src/components/journal/Journal.js
import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, addTrade, updateTrade, deleteTrade, calcStats } from '../../services/trades';
import { formatCurrency, formatNumber } from '../../utils/calculator';
import toast from 'react-hot-toast';
import TradeModal from './TradeModal';
import './Journal.css';

const COLS = ['Тикер', 'Дата', 'Направление', 'Вход', 'Выход', 'Объём', 'P&L', '% депоз.', 'Статус', ''];

export default function Journal() {
  const { user, userProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTrade, setEditTrade] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  // Быстрое закрытие сделки
  const [closeModal, setCloseModal] = useState(null);
  // Кастомный confirm вместо window.confirm
  const [confirmDelete, setConfirmDelete] = useState(null); // trade.id // trade object
  const [closePrice, setClosePrice] = useState('');
  const [closing, setClosing] = useState(false);

  const deposit = userProfile?.depositSize || 100000;

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
    setConfirmDelete(id);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    await deleteTrade(confirmDelete);
    toast.success('Сделка удалена');
    setConfirmDelete(null);
    await load();
  };

  const openEdit = (trade) => {
    setEditTrade(trade);
    setModalOpen(true);
  };

  // Быстрое закрытие: открыть мини-модал
  const openClose = (trade) => {
    setCloseModal(trade);
    setClosePrice('');
  };

  // Автоматический расчёт P&L при закрытии
  const calcQuickPnl = () => {
    const exit = parseFloat(closePrice);
    const entry = parseFloat(closeModal?.entryPrice);
    const vol = parseFloat(closeModal?.volume) || 1;
    const lot = parseFloat(closeModal?.lot) || 1;
    const step = parseFloat(closeModal?.minStep) || 1;
    const stepAmt = parseFloat(closeModal?.minStepAmount) || 0;
    const commRate = parseFloat(closeModal?.commissionRate) || 0.0006;
    const dir = closeModal?.direction;

    if (!exit || !entry) return null;

    let pnl;
    if (step && stepAmt) {
      const ticks = (exit - entry) / step;
      pnl = (dir === 'long' ? ticks : -ticks) * stepAmt * vol * lot;
    } else {
      pnl = (dir === 'long' ? (exit - entry) : (entry - exit)) * vol * lot;
    }

    const commission = entry * vol * lot * commRate * 2;
    const net = pnl - commission;
    return { pnl: Math.round(net * 100) / 100, commission: Math.round(commission * 100) / 100 };
  };

  const handleQuickClose = async () => {
    if (!closePrice || !closeModal) return;
    setClosing(true);
    try {
      const result = calcQuickPnl();
      await updateTrade(closeModal.id, {
        ...closeModal,
        exitPrice: parseFloat(closePrice),
        status: 'closed',
        pnl: result?.pnl ?? 0,
        commission: result?.commission ?? 0,
        closeDate: new Date().toISOString(),
      });
      toast.success(`Сделка закрыта. P&L: ${result?.pnl >= 0 ? '+' : ''}${formatCurrency(result?.pnl ?? 0)}`);
      setCloseModal(null);
      setClosePrice('');
      await load();
    } catch (e) {
      toast.error('Ошибка закрытия сделки');
    } finally {
      setClosing(false);
    }
  };

  const quickResult = closeModal && closePrice ? calcQuickPnl() : null;

  const filtered = trades
    .filter(t => {
      if (filter === 'long') return t.direction === 'long';
      if (filter === 'short') return t.direction === 'short';
      if (filter === 'open') return t.status === 'open';
      if (filter === 'closed') return t.status === 'closed';
      return true;
    })
    .filter(t => !search || t.ticker?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      // Открытые всегда сверху
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (b.status === 'open' && a.status !== 'open') return 1;

      const getTs = (t) => {
        // Для открытых — по createdAt (время создания), новые сверху
        if (t.status === 'open') {
          if (t.createdAt?.seconds) return t.createdAt.seconds * 1000;
          if (t.createdAt) return new Date(t.createdAt).getTime();
        }
        // Для закрытых — по дате закрытия
        if (t.closeDate) return new Date(t.closeDate).getTime();
        if (t.date?.seconds) return t.date.seconds * 1000;
        if (t.date) return new Date(t.date).getTime();
        return 0;
      };
      return getTs(b) - getTs(a);
    });

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
                      {trade.pnl !== undefined && trade.pnl !== null && deposit ? (
                        <span style={{
                          color: trade.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                          fontWeight: 600, fontSize: 13,
                        }}>
                          {trade.pnl >= 0 ? '+' : ''}{((trade.pnl / deposit) * 100).toFixed(2)}%
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      <span className={`badge ${trade.status==='open' ? 'badge-blue' : trade.pnl >= 0 ? 'badge-green' : 'badge-red'}`}>
                        {trade.status==='open' ? 'Открыта' : 'Закрыта'}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-2" style={{alignItems:'center'}}>
                        {/* Кнопка "Закрыть сделку" — только для открытых */}
                        {trade.status === 'open' && (
                          <button
                            className="btn btn-sm"
                            style={{
                              background: 'linear-gradient(135deg, #10b981, #059669)',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 8,
                              padding: '4px 10px',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                              boxShadow: '0 2px 8px rgba(16,185,129,0.3)',
                            }}
                            onClick={() => openClose(trade)}
                            title="Закрыть сделку"
                          >
                            ✅ Закрыть
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(trade)} title="Редактировать">✏️</button>
                        <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={() => handleDelete(trade.id)} title="Удалить">🗑</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Мини-модал быстрого закрытия */}
      {closeModal && (
        <div className="modal-overlay" onClick={() => setCloseModal(null)}>
          <div className="modal" style={{maxWidth:400}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">✅ Закрыть сделку</h3>
              <button className="modal-close" onClick={() => setCloseModal(null)}>✕</button>
            </div>

            <div style={{padding:'0 0 8px'}}>
              {/* Инфо о сделке */}
              <div style={{
                background:'rgba(79,70,229,0.08)',
                border:'1px solid rgba(79,70,229,0.2)',
                borderRadius:12,
                padding:'12px 16px',
                marginBottom:20,
              }}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Тикер</span>
                  <span style={{fontWeight:700,color:'var(--accent-primary)'}}>{closeModal.ticker}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Цена входа</span>
                  <span style={{fontWeight:600}}>{formatNumber(closeModal.entryPrice, 2)}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Объём</span>
                  <span style={{fontWeight:600}}>{closeModal.volume} конт.</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Направление</span>
                  <span style={{color: closeModal.direction==='long' ? 'var(--green)' : 'var(--red)', fontWeight:600}}>
                    {closeModal.direction === 'long' ? '📈 Лонг' : '📉 Шорт'}
                  </span>
                </div>
              </div>

              {/* Поле цены выхода */}
              <div style={{marginBottom:4}}>
                <label style={{
                  display:'block', fontSize:11, fontWeight:500,
                  color:'rgba(255,255,255,0.4)', letterSpacing:'0.3px',
                  marginBottom:4, paddingLeft:4,
                }}>
                  Цена выхода *
                </label>
                <div style={{
                  display:'flex', alignItems:'center',
                  background:'rgba(255,255,255,0.05)',
                  border:'1px solid rgba(79,70,229,0.4)',
                  borderRadius:10, overflow:'hidden',
                  boxShadow:'0 0 0 2px rgba(79,70,229,0.1)',
                }}>
                  <input
                    type="number"
                    step="any"
                    placeholder="Цена закрытия"
                    value={closePrice}
                    onChange={e => setClosePrice(e.target.value)}
                    autoFocus
                    style={{
                      flex:1, background:'none', border:'none', outline:'none',
                      padding:'9px 12px',
                      fontSize:13, fontFamily:'inherit',
                      color:'#f0f4ff', fontWeight:600,
                    }}
                  />
                </div>
              </div>

              {/* Предпросмотр P&L */}
              {quickResult && (
                <div style={{
                  marginTop:16,
                  padding:'12px 16px',
                  background: quickResult.pnl >= 0 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${quickResult.pnl >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  borderRadius:12,
                }}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                    <span style={{color:'var(--text-muted)',fontSize:12}}>P&L (с комиссией)</span>
                    <span style={{
                      fontWeight:700,
                      fontSize:16,
                      color: quickResult.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                    }}>
                      {quickResult.pnl >= 0 ? '+' : ''}{formatCurrency(quickResult.pnl)}
                    </span>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between'}}>
                    <span style={{color:'var(--text-muted)',fontSize:12}}>Комиссия</span>
                    <span style={{color:'var(--text-muted)',fontSize:12}}>{formatCurrency(quickResult.commission)}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer" style={{marginTop:20}}>
              <button className="btn btn-ghost" onClick={() => setCloseModal(null)}>Отмена</button>
              <button
                className="btn btn-primary"
                onClick={handleQuickClose}
                disabled={!closePrice || closing}
                style={{background:'linear-gradient(135deg,#10b981,#059669)'}}
              >
                {closing ? 'Закрываем...' : '✅ Закрыть сделку'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Кастомный модал подтверждения удаления */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" style={{maxWidth:360}} onClick={e => e.stopPropagation()}>
            <div className="modal-header" style={{borderBottom:'1px solid rgba(239,68,68,0.2)'}}>
              <h3 className="modal-title" style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{
                  width:32,height:32,borderRadius:'50%',
                  background:'rgba(239,68,68,0.15)',
                  display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,
                }}>🗑</span>
                Удалить сделку?
              </h3>
              <button className="modal-close" onClick={() => setConfirmDelete(null)}>✕</button>
            </div>
            <div style={{padding:'16px 0', color:'var(--text-muted)', fontSize:14, lineHeight:1.6, textAlign:'center'}}>
              Это действие нельзя отменить. Сделка будет удалена из журнала навсегда.
            </div>
            <div className="modal-footer" style={{marginTop:8}}>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>
                Отмена
              </button>
              <button
                className="btn"
                onClick={handleConfirmDelete}
                style={{
                  background:'linear-gradient(135deg,#ef4444,#dc2626)',
                  color:'#fff', border:'none',
                  boxShadow:'0 4px 12px rgba(239,68,68,0.3)',
                }}
              >
                🗑 Удалить
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <TradeModal
          trade={editTrade}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditTrade(null); }}
          defaultDeposit={userProfile?.depositSize}
        />
      )}
    </div>
  );
}
