// src/components/layout/Sidebar.js
import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import './Sidebar.css';

const NAV_ITEMS = [
  { path: '/', icon: '📊', label: 'Дашборд' },
  { path: '/calculator', icon: '🧮', label: 'Калькулятор' },
  { path: '/journal', icon: '📓', label: 'Журнал' },
  { path: '/capital', icon: '💰', label: 'Капитал' },
  { path: '/advisor', icon: '🤖', label: 'AI Советник' },
  { path: '/settings', icon: '⚙️', label: 'Настройки' },
];

const ADMIN_ITEMS = [
  { path: '/admin', icon: '🛡️', label: 'Админ-панель' },
];

export default function Sidebar() {
  const { userProfile, logout, isAdmin, isPro } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const location = useLocation();

  const items = isAdmin ? [...NAV_ITEMS, ...ADMIN_ITEMS] : NAV_ITEMS;

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-icon">T</div>
        <div className="logo-text">
          <span className="logo-name">TraderPro</span>
          <span className="logo-sub">v2.0</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        {items.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {location.pathname === item.path && <span className="nav-indicator" />}
          </NavLink>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="sidebar-bottom">
        <button className="theme-toggle" onClick={toggleTheme} title="Переключить тему">
          <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
          <span className="theme-label">{theme === 'dark' ? 'Светлая' : 'Тёмная'}</span>
        </button>

        <div className="profile-section">
          <button className="profile-btn" onClick={() => setProfileOpen(!profileOpen)}>
            <div className="profile-avatar">
              {(userProfile?.displayName || 'U')[0].toUpperCase()}
            </div>
            <div className="profile-info">
              <span className="profile-name">
                {userProfile?.displayName || 'Трейдер'}
              </span>
              <span className="profile-email">
                {isAdmin
                  ? <span style={{color:'#818cf8',fontSize:10,fontWeight:700}}>👑 Admin</span>
                  : isPro
                  ? <span style={{color:'#f59e0b',fontSize:10,fontWeight:700}}>⚡ Pro</span>
                  : <span style={{color:'var(--text-muted)',fontSize:10}}>Free</span>
                }
              </span>
            </div>
            <span className="profile-chevron">{profileOpen ? '▲' : '▼'}</span>
          </button>

          {profileOpen && (
            <div className="profile-dropdown">
              <div className="dropdown-divider" />
              <button className="dropdown-item danger" onClick={logout}>
                🚪 Выйти
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
