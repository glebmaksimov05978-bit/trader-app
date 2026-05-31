// src/components/layout/MobileNav.js
import React from 'react';
import { NavLink } from 'react-router-dom';
import './Sidebar.css';

const ITEMS = [
  { path: '/', icon: '📊', label: 'Дашборд' },
  { path: '/calculator', icon: '🧮', label: 'Расчёт' },
  { path: '/journal', icon: '📓', label: 'Журнал' },
  { path: '/capital', icon: '💰', label: 'Капитал' },
  { path: '/advisor', icon: '🤖', label: 'AI' },
  { path: '/settings', icon: '⚙️', label: 'Настройки' },
];

export default function MobileNav() {
  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-items">
        {ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="mobile-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
