// src/components/auth/LoginPage.js
import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import './LoginPage.css';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [focused, setFocused] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    try {
      const email = username.includes('@') ? username : `${username}@trader.com`;
      await login(email, password);
      navigate('/');
    } catch (err) {
      const msg =
        err.code === 'auth/invalid-credential'
          ? 'Неверный логин или пароль'
          : err.code === 'auth/too-many-requests'
          ? 'Слишком много попыток. Подождите немного.'
          : 'Ошибка входа. Проверьте данные.';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg">
        <div className="bg-orb bg-orb-1" />
        <div className="bg-orb bg-orb-2" />
        <div className="bg-orb bg-orb-3" />
        <div className="bg-grid" />
      </div>

      {[...Array(6)].map((_, i) => (
        <div key={i} className={`particle particle-${i + 1}`} />
      ))}

      <div className="login-wrapper">
        <div className="login-brand">
          <div className="brand-logo">
            <div className="brand-logo-icon">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <path d="M14 2L26 8V20L14 26L2 20V8L14 2Z" stroke="white" strokeWidth="1.5" fill="none"/>
                <path d="M14 7L21 11V17L14 21L7 17V11L14 7Z" fill="white" fillOpacity="0.3"/>
                <circle cx="14" cy="14" r="3" fill="white"/>
              </svg>
            </div>
            <span className="brand-name">TraderPro</span>
          </div>

          <div className="brand-content">
            <h1 className="brand-title">
              Торгуй умнее.<br />
              <span className="brand-title-accent">Зарабатывай больше.</span>
            </h1>
            <p className="brand-desc">
              Профессиональный инструмент для трейдера — калькулятор, журнал сделок и AI-советник в одном месте.
            </p>
          </div>

          <div className="brand-stats">
            <div className="brand-stat">
              <span className="brand-stat-value">AI</span>
              <span className="brand-stat-label">Советник</span>
            </div>
            <div className="brand-stat-divider" />
            <div className="brand-stat">
              <span className="brand-stat-value">24/7</span>
              <span className="brand-stat-label">Доступ</span>
            </div>
            <div className="brand-stat-divider" />
            <div className="brand-stat">
              <span className="brand-stat-value">∞</span>
              <span className="brand-stat-label">Сделок</span>
            </div>
          </div>
        </div>

        <div className="login-form-side">
          <div className="login-card">
            <div className="login-card-header">
              <div className="login-card-badge">Личный кабинет</div>
              <h2 className="login-card-title">Вход в систему</h2>
              <p className="login-card-sub">Введите ваши данные для входа</p>
            </div>

            <form onSubmit={handleSubmit} className="login-form">
              <div className={`login-field ${focused === 'user' ? 'focused' : ''} ${username ? 'has-value' : ''}`}>
                <label className="login-field-label">Логин</label>
                <div className="login-field-wrap">
                  <div className="login-field-icon">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M2 14c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <input
                    className="login-input"
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    onFocus={() => setFocused('user')}
                    onBlur={() => setFocused('')}
                    placeholder="ваш_логин"
                    autoComplete="username"
                    required
                  />
                </div>
              </div>

              <div className={`login-field ${focused === 'pass' ? 'focused' : ''} ${password ? 'has-value' : ''}`}>
                <label className="login-field-label">Пароль</label>
                <div className="login-field-wrap">
                  <div className="login-field-icon">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <rect x="3" y="7" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      <circle cx="8" cy="11" r="1.5" fill="currentColor"/>
                    </svg>
                  </div>
                  <input
                    className="login-input"
                    type={showPass ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onFocus={() => setFocused('pass')}
                    onBlur={() => setFocused('')}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                  />
                  <button type="button" className="login-eye" onClick={() => setShowPass(!showPass)}>
                    {showPass ? (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M2 8s2.5-5 6-5 6 5 6 5-2.5 5-6 5-6-5-6-5z" stroke="currentColor" strokeWidth="1.5"/>
                        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
                        <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M2 8s2.5-5 6-5 6 5 6 5-2.5 5-6 5-6-5-6-5z" stroke="currentColor" strokeWidth="1.5"/>
                        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <button type="submit" className={`login-btn ${loading ? 'loading' : ''}`} disabled={loading || !username || !password}>
                {loading ? (
                  <span className="login-btn-content">
                    <span className="login-spinner" />
                    Вход...
                  </span>
                ) : (
                  <span className="login-btn-content">
                    Войти
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                )}
              </button>
            </form>

            <div className="login-footer">
              <div className="login-footer-line" />
              <span className="login-footer-text">Доступ предоставляется администратором</span>
              <div className="login-footer-line" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
