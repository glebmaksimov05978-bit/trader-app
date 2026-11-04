// src/components/auth/LoginPage.js
import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import './LoginPage.css';
import LoginBackdrop from './LoginBackground';
import BrandMark, { useBrandVariant } from '../shared/BrandMark';
import LoginDevSwitcher from './LoginDevSwitcher';
import Icon from '../shared/Icon';
import { useTheme } from '../../context/ThemeContext';

// Панель сравнения фонов и знаков — только при разработке (npm start), на сайте её нет.
const DEV_SWITCHER = process.env.NODE_ENV !== 'production';

// SVG иконки
const IconUser = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M2 14c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);
const IconMail = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="4" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M2 6l6 4 6-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);
const IconLock = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="7" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="8" cy="11" r="1.5" fill="currentColor"/>
  </svg>
);
const IconArrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconGoogle = () => (
  <svg width="18" height="18" viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.62z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 009 18z"/>
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 013.68 9c0-.59.1-1.17.27-1.7V4.97H.98A9 9 0 000 9c0 1.45.35 2.83.98 4.04l2.97-2.33z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
  </svg>
);

function EyeIcon({ open }) {
  return open ? (
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
  );
}

function Field({ label, focused, icon, children }) {
  return (
    <div className={`login-field ${focused ? 'focused' : ''}`}>
      <label className="login-field-label">{label}</label>
      <div className="login-field-wrap">
        <div className="login-field-icon">{icon}</div>
        {children}
      </div>
    </div>
  );
}

// Навигация по полям формы стрелками вверх/вниз и Enter — как Tab, но с клавиатуры без мыши
function handleArrowNav(e) {
  const isEnter = e.key === 'Enter';
  const isDown = e.key === 'ArrowDown';
  const isUp = e.key === 'ArrowUp';
  if (!isEnter && !isDown && !isUp) return;

  const form = e.target.closest('form');
  if (!form) return;
  const focusable = Array.from(
    form.querySelectorAll('input:not([type="hidden"]), button[type="submit"]')
  );
  const index = focusable.indexOf(e.target);
  if (index === -1) return;

  // Enter на последнем поле — пусть форма отправляется как обычно
  const isLastField = index === focusable.length - 2; // последнее поле перед кнопкой submit
  if (isEnter && isLastField) return;

  e.preventDefault();
  const nextIndex = isUp ? index - 1 : index + 1;
  const next = focusable[nextIndex];
  if (next) next.focus();
}

// Модал сброса пароля
function ResetModal({ onClose }) {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleReset = async () => {
    if (!email) return;
    setLoading(true);
    try {
      await resetPassword(email);
      setSent(true);
      toast.success('Письмо отправлено!');
    } catch (err) {
      toast.error(err.code === 'auth/user-not-found' ? 'Email не найден' : 'Ошибка. Проверьте email.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-modal-overlay" onClick={onClose}>
      <div className="login-modal" onClick={e => e.stopPropagation()}>
        <div className="login-modal-header">
          <div className="login-modal-icon"><Icon name="lock" size={26} /></div>
          <h3 className="login-modal-title">Сброс пароля</h3>
          <p className="login-modal-sub">Введите email — пришлём ссылку для сброса</p>
        </div>
        {!sent ? (
          <>
            <div className={`login-field`} style={{marginBottom:16}}>
              <label className="login-field-label">Email</label>
              <div className="login-field-wrap">
                <div className="login-field-icon"><IconMail /></div>
                <input
                  className="login-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  autoFocus
                />
              </div>
            </div>
            <button className="login-btn" onClick={handleReset} disabled={loading || !email}>
              <span className="login-btn-content">
                {loading ? <><span className="login-spinner"/> Отправка...</> : <>Отправить письмо <IconArrow /></>}
              </span>
            </button>
          </>
        ) : (
          <div className="login-modal-done">
            <div className="login-modal-done-icon"><Icon name="check" size={32} /></div>
            <p>
              Письмо отправлено на <strong>{email}</strong>.<br/>
              Проверьте папку «Спам», если не видите письма.
            </p>
          </div>
        )}
        <button onClick={onClose} className="login-modal-close" aria-label="Закрыть"><Icon name="close" size={14} /></button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [focused, setFocused] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);

  // Логин
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Регистрация
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regPass2, setRegPass2] = useState('');

  const { login, register, loginWithGoogle } = useAuth();
  const { theme, toggleTheme } = useTheme();
  // ВРЕМЕННО: выбор фона и знака (см. LoginDevSwitcher) — только в режиме разработки.
  // На сайте у всех один фон — «Живой график».
  const [brandVariant, setBrandVariant] = useBrandVariant();
  const [bg, setBgState] = useState(() => {
    if (!DEV_SWITCHER) return 'live';
    try { return localStorage.getItem('loginBg') || 'live'; } catch { return 'live'; }
  });
  const setBg = (v) => {
    setBgState(v);
    try { localStorage.setItem('loginBg', v); } catch { /* не страшно */ }
  };
  const navigate = useNavigate();
  const [googleLoading, setGoogleLoading] = useState(false);

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    try {
      await loginWithGoogle();
      navigate('/');
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        toast.error('Не удалось войти через Google');
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleLogin = async (e) => {
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

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!regName || !regEmail || !regPass) return;
    if (regPass !== regPass2) { toast.error('Пароли не совпадают'); return; }
    if (regPass.length < 6) { toast.error('Пароль минимум 6 символов'); return; }
    setLoading(true);
    try {
      await register(regEmail, regPass, regName);
      toast.success('Аккаунт создан. Добро пожаловать!');
      navigate('/');
    } catch (err) {
      const msg =
        err.code === 'auth/email-already-in-use' ? 'Этот email уже используется' :
        err.code === 'auth/invalid-email' ? 'Некорректный email' :
        'Ошибка регистрации. Попробуйте снова.';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <LoginBackdrop variant={bg} />
      {DEV_SWITCHER && <LoginDevSwitcher bg={bg} onBg={setBg} icon={brandVariant} onIcon={setBrandVariant} />}

      <button type="button" className="login-theme-btn" onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
      </button>

      <div className="login-wrapper">
        {/* Левая часть — о продукте */}
        <div className="login-brand">
          <div className="brand-logo">
            <div className="brand-logo-icon">
              <BrandMark size={44} />
            </div>
            <span className="brand-name">TraderPro</span>
          </div>
          <div className="brand-content">
            <h1 className="brand-title">Контроль риска и дисциплины в каждой сделке</h1>
            <p className="brand-desc">
              Рабочее место трейдера на российском рынке: расчёт сделки, журнал, сопровождение позиций и отчёты.
            </p>
          </div>
          <ul className="brand-features">
            <li className="brand-feature">
              <span className="brand-feature-icon"><Icon name="calculator" size={18} /></span>
              <div>
                <div className="brand-feature-title">Калькулятор сделки</div>
                <div className="brand-feature-text">Объём, стоп и цель по вашим правилам риска</div>
              </div>
            </li>
            <li className="brand-feature">
              <span className="brand-feature-icon"><Icon name="journal" size={18} /></span>
              <div>
                <div className="brand-feature-title">Журнал и импорт отчётов</div>
                <div className="brand-feature-text">Сделки подтягиваются из отчётов брокера, привычки считаются сами</div>
              </div>
            </li>
            <li className="brand-feature">
              <span className="brand-feature-icon"><Icon name="cockpit" size={18} /></span>
              <div>
                <div className="brand-feature-title">Сопровождение позиций</div>
                <div className="brand-feature-text">Радар, сигналы и уведомления в Telegram</div>
              </div>
            </li>
          </ul>
        </div>

        {/* Правая форма */}
        <div className="login-form-side">
          <div className="login-card">

            {/* Переключатель Вход / Регистрация */}
            <div className="login-tabs">
              <button
                className={`login-tab ${mode === 'login' ? 'active' : ''}`}
                onClick={() => setMode('login')}
              >Вход</button>
              <button
                className={`login-tab ${mode === 'register' ? 'active' : ''}`}
                onClick={() => setMode('register')}
              >Регистрация</button>
            </div>

            {mode === 'login' ? (
              <>
                <div className="login-card-header">
                  <h2 className="login-card-title">Вход в систему</h2>
                  <p className="login-card-sub">Введите ваши данные для входа</p>
                </div>

    <form onSubmit={handleLogin} className="login-form" autoComplete="off">
                  <Field label="Email или логин" focused={focused === 'user'} icon={<IconUser />}>
                    <input className="login-input" type="text" value={username}
                      onChange={e => setUsername(e.target.value)}
                      onFocus={() => setFocused('user')} onBlur={() => setFocused('')}
                      onKeyDown={handleArrowNav}
                      placeholder="email или логин" autoComplete="off" name="login" required />
                  </Field>

                  <Field label="Пароль" focused={focused === 'pass'} icon={<IconLock />}>
                    <input className="login-input" type={showPass ? 'text' : 'password'}
                      value={password} onChange={e => setPassword(e.target.value)}
                      onFocus={() => setFocused('pass')} onBlur={() => setFocused('')}
                      onKeyDown={handleArrowNav}
                      placeholder="••••••••" autoComplete="current-password" name="password" required />
                    <button type="button" className="login-eye" onClick={() => setShowPass(!showPass)}>
                      <EyeIcon open={showPass} />
                    </button>
                  </Field>

                  {/* Забыл пароль */}
                  <button type="button" className="login-forgot" onClick={() => setShowReset(true)}>
                    Забыли пароль?
                  </button>

                  <button type="submit" className="login-btn" disabled={loading || !username || !password}>
                    <span className="login-btn-content">
                      {loading ? <><span className="login-spinner"/> Вход...</> : <>Войти <IconArrow /></>}
                    </span>
                  </button>
                </form>

                <div className="login-footer">
                  <div className="login-footer-line" />
                  <span className="login-footer-text">или</span>
                  <div className="login-footer-line" />
                </div>

                <button type="button" className="login-google" onClick={handleGoogleLogin} disabled={googleLoading}>
                  {googleLoading ? <span className="login-spinner"/> : <IconGoogle />}
                  {googleLoading ? 'Входим...' : 'Войти через Google'}
                </button>
              </>
            ) : (
              <>
                <div className="login-card-header">
                  <h2 className="login-card-title">Регистрация</h2>
                  <p className="login-card-sub">Создайте аккаунт бесплатно</p>
                </div>

                <form onSubmit={handleRegister} className="login-form">
                  <Field label="Имя / никнейм" focused={focused === 'name'} icon={<IconUser />}>
                    <input className="login-input" type="text" value={regName}
                      onChange={e => setRegName(e.target.value)}
                      onFocus={() => setFocused('name')} onBlur={() => setFocused('')}
                      onKeyDown={handleArrowNav}
                      placeholder="Ваше имя" required />
                  </Field>

                  <Field label="Email" focused={focused === 'email'} icon={<IconMail />}>
                    <input className="login-input" type="email" value={regEmail}
                      onChange={e => setRegEmail(e.target.value)}
                      onFocus={() => setFocused('email')} onBlur={() => setFocused('')}
                      onKeyDown={handleArrowNav}
                      placeholder="your@email.com" autoComplete="email" required />
                  </Field>

                  <Field label="Пароль" focused={focused === 'rpass'} icon={<IconLock />}>
                    <input className="login-input" type={showPass ? 'text' : 'password'}
                      value={regPass} onChange={e => setRegPass(e.target.value)}
                      onFocus={() => setFocused('rpass')} onBlur={() => setFocused('')}
                      onKeyDown={handleArrowNav}
                      placeholder="Минимум 6 символов" autoComplete="new-password" required />
                    <button type="button" className="login-eye" onClick={() => setShowPass(!showPass)}>
                      <EyeIcon open={showPass} />
                    </button>
                  </Field>

                  <Field label="Повторите пароль" focused={focused === 'rpass2'} icon={<IconLock />}>
                    <input className="login-input" type={showPass ? 'text' : 'password'}
                      value={regPass2} onChange={e => setRegPass2(e.target.value)}
                      onFocus={() => setFocused('rpass2')} onBlur={() => setFocused('')}
                      onKeyDown={handleArrowNav}
                      placeholder="Повторите пароль" autoComplete="new-password" required />
                  </Field>

                  <button type="submit" className="login-btn"
                    disabled={loading || !regName || !regEmail || !regPass || !regPass2}>
                    <span className="login-btn-content">
                      {loading ? <><span className="login-spinner"/> Создание...</> : <>Создать аккаунт <IconArrow /></>}
                    </span>
                  </button>
                </form>

                <div className="login-footer">
                  <div className="login-footer-line" />
                  <span className="login-footer-text">или</span>
                  <div className="login-footer-line" />
                </div>

                <button type="button" className="login-google" onClick={handleGoogleLogin} disabled={googleLoading}>
                  {googleLoading ? <span className="login-spinner"/> : <IconGoogle />}
                  {googleLoading ? 'Входим...' : 'Продолжить с Google'}
                </button>

                <div className="login-footer">
                  <div className="login-footer-line" />
                  <span className="login-footer-text">Бесплатно · Без карты</span>
                  <div className="login-footer-line" />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showReset && <ResetModal onClose={() => setShowReset(false)} />}
    </div>
  );
}
