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
        err.code === 'auth/invalid-credential' ? 'Неверный логин или пароль' :
        err.code === 'auth/too-many-requests' ? 'Слишком много попыток. Подождите.' :
        'Ошибка входа. Проверьте данные.';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const particles = Array.from({length: 20}, (_, i) => i);

  return (
    <div className="login-page">
      <div className="login-bg">
        <div className="bg-orb bg-orb-1" />
        <div className="bg-orb bg-orb-2" />
        <div className="bg-orb bg-orb-3" />
        <div className="bg-grid" />
      </div>

      {particles.map((i) => (
        <div key={i} className="particle" style={{
          left: `${5 + (i * 4.7) % 90}%`,
          top: `${10 + (i * 7.3) % 80}%`,
          animationDuration: `${9 + (i * 1.3) % 8}s`,
          animationDelay: `-${(i * 0.7) % 10}s`,
          width: `${3 + (i % 3)}px`,
          height: `${3 + (i % 3)}px`,
          background: i % 4 === 0 ? 'rgba(79,70,229,0.8)' :
                      i % 4 === 1 ? 'rgba(124,58,237,0.7)' :
                      i % 4 === 2 ? 'rgba(16,185,129,0.6)' :
                                    'rgba(245,158,11,0.6)',
        }} />
      ))}

      <div className="login-wrapper">
        {/* Left brand */}
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
              <svg className="brand-infinity" viewBox="0 0 48 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M24 12C24 12 19 4 12 4C5 4 2 8 2 12C2 16 5 20 12 20C19 20 24 12 24 12Z" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                <path d="M24 12C24 12 29 4 36 4C43 4 46 8 46 12C46 16 43 20 36 20C29 20 24 12 24 12Z" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
              </svg>
              <span className="brand-stat-label">Сделок</span>
            </div>
          </div>
        </div>

        {/* Right form */}
        <div className="login-form-side">
          <div className="login-card">
            <div className="login-card-header">
              <div className="login-card-badge">Личный кабинет</div>
              <h2 className="login-card-title">Вход в систему</h2>
              <p className="login-card-sub">Введите ваши данные для входа</p>
            </div>

            <form onSubmit={handleSubmit} className="login-form">
              <div className={`login-field ${focused === 'user' ? 'focused' : ''}`}>
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

              <div className={`login-field ${focused === 'pass' ? 'focused' : ''}`}>
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

              <button type="submit" className={`login-btn ${loading ? 'loading' : ''}`}
                disabled={loading || !username || !password}>
                {loading ? (
                  <span className="login-btn-content">
                    <span className="login-spinner" /> Вход...
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
