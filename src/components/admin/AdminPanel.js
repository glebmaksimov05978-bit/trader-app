// src/components/admin/AdminPanel.js
import React, { useState, useEffect } from 'react';
import { collection, getDocs, setDoc, doc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import { db } from '../../services/firebase';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

export default function AdminPanel() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ email: '', password: '', displayName: '', role: 'user' });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isAdmin) { navigate('/'); return; }
    loadUsers();
  }, [isAdmin, navigate]);

  const loadUsers = async () => {
    setLoading(true);
    const snap = await getDocs(collection(db, 'users'));
    setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  };

  const createUser = async () => {
    if (!form.email || !form.password) return;
    setCreating(true);
    try {
      // Note: creating users from client requires Admin SDK or Firebase Auth in a serverless function
      // This uses secondary auth instance workaround
      const secondaryApp = getAuth();
      const { user } = await createUserWithEmailAndPassword(secondaryApp, form.email, form.password);
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        email: form.email,
        displayName: form.displayName || form.email.split('@')[0],
        role: form.role,
        depositSize: 100000,
        dailyLossLimit: 3,
        maxRiskPerTrade: 1,
        createdAt: serverTimestamp(),
      });
      toast.success(`Пользователь ${form.email} создан`);
      setForm({ email: '', password: '', displayName: '', role: 'user' });
      await loadUsers();
    } catch (err) {
      toast.error(err.message);
    }
    setCreating(false);
  };

  const setRole = async (uid, role) => {
    await setDoc(doc(db, 'users', uid), { role }, { merge: true });
    toast.success('Роль обновлена');
    await loadUsers();
  };

  if (!isAdmin) return null;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">⚙️ Админ-панель</h1>
        <p className="page-subtitle">Управление пользователями</p>
      </div>

      {/* Create user */}
      <div className="card" style={{marginBottom:24}}>
        <div className="section-title">
          <div className="section-title-icon">➕</div>
          Создать пользователя
        </div>
        <div className="grid-4" style={{marginBottom:16}}>
          <div className="input-group">
            <label className="input-label">Email</label>
            <input className="input" type="email" value={form.email}
              onChange={e => setForm(f => ({...f, email: e.target.value}))} placeholder="email@example.com"/>
          </div>
          <div className="input-group">
            <label className="input-label">Пароль</label>
            <input className="input" type="text" value={form.password}
              onChange={e => setForm(f => ({...f, password: e.target.value}))} placeholder="минимум 6 символов"/>
          </div>
          <div className="input-group">
            <label className="input-label">Имя</label>
            <input className="input" value={form.displayName}
              onChange={e => setForm(f => ({...f, displayName: e.target.value}))} placeholder="Имя трейдера"/>
          </div>
          <div className="input-group">
            <label className="input-label">Роль</label>
            <select className="input" value={form.role} onChange={e => setForm(f => ({...f, role: e.target.value}))}>
              <option value="free">Free</option>
              <option value="user">Трейдер</option>
              <option value="admin">Администратор</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" onClick={createUser} disabled={creating}>
          {creating ? 'Создание...' : '+ Создать аккаунт'}
        </button>
      </div>

      {/* Users table */}
      <div className="card" style={{padding:0}}>
        <div style={{padding:'20px 24px 0'}}>
          <div className="section-title">
            <div className="section-title-icon">👥</div>
            Пользователи ({users.length})
          </div>
        </div>
        {loading ? (
          <div className="empty-state"><div className="spinner" style={{width:28,height:28}}/></div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Email</th>
                  <th>Роль</th>
                  <th>Депозит</th>
                  <th>Создан</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td><span className="font-semibold">{u.displayName || '—'}</span></td>
                    <td className="text-secondary">{u.email}</td>
                    <td>
                      <span className={`badge ${u.role === 'admin' ? 'badge-purple' : u.role === 'pro' ? 'badge-gold' : u.role === 'free' ? 'badge-blue' : 'badge-blue'}`}>
                        {u.role === 'admin' ? '👑 Admin' : u.role === 'pro' ? '⚡ Pro' : u.role === 'free' ? '🆓 Free' : '👤 User'}
                      </span>
                    </td>
                    <td>{u.depositSize ? u.depositSize.toLocaleString('ru-RU') + ' ₽' : '—'}</td>
                    <td className="text-muted text-xs">
                      {u.createdAt?.seconds
                        ? new Date(u.createdAt.seconds * 1000).toLocaleDateString('ru-RU')
                        : '—'}
                    </td>
                    <td>
                      <div className="flex gap-2" style={{flexWrap:'wrap'}}>
                        {/* Pro кнопка */}
                        {u.role !== 'pro' && u.role !== 'admin' && (
                          <button
                            style={{background:'linear-gradient(135deg,#f59e0b,#d97706)',color:'#000',fontSize:11,padding:'4px 10px',borderRadius:8,border:'none',cursor:'pointer',fontWeight:700}}
                            onClick={() => setRole(u.id, 'pro')}>
                            ⚡ Дать Pro
                          </button>
                        )}
                        {u.role === 'pro' && (
                          <button className="btn btn-ghost btn-sm" style={{fontSize:11}}
                            onClick={() => setRole(u.id, 'free')}>
                            Снять Pro
                          </button>
                        )}
                        {/* Админ кнопка */}
                        {u.role !== 'admin' && (
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => setRole(u.id, 'admin')}>
                            👑 Админ
                          </button>
                        )}
                        {u.role === 'admin' && (
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => setRole(u.id, 'free')}>
                            Снять права
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
