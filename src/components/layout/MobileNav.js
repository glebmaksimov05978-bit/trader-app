// src/components/layout/MobileNav.js
import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { TRUSTED_UIDS } from '../../constants/trustedUids';
import { NAV_ITEMS, ADMIN_ITEMS, TRUSTED_ITEMS } from '../../constants/navItems';
import './Sidebar.css';

export default function MobileNav() {
  const { user, isAdmin } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Same gate as the desktop Sidebar — internal tools (Бэктест, admin panel) stay off
  // the bottom bar for everyone else, so ordinary traders never see an empty-looking
  // hamburger menu (real user report was specifically "у меня, доверенного, нет
  // Бэктеста на телефоне" — not "add a general menu for everyone").
  const isTrusted = isAdmin || TRUSTED_UIDS.includes(user?.uid);
  const extraItems = [...(isTrusted ? TRUSTED_ITEMS : []), ...(isAdmin ? ADMIN_ITEMS : [])];

  return (
    <>
      {extraItems.length > 0 && (
        <>
          <button
            className="mobile-hamburger"
            onClick={() => setDrawerOpen(true)}
            aria-label="Ещё разделы"
          >
            ☰
          </button>
          {drawerOpen && (
            <div className="mobile-drawer-overlay" onClick={() => setDrawerOpen(false)}>
              <div className="mobile-drawer" onClick={(e) => e.stopPropagation()}>
                <div className="mobile-drawer-header">
                  <span>Ещё</span>
                  <button className="mobile-drawer-close" onClick={() => setDrawerOpen(false)}>✕</button>
                </div>
                {extraItems.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) => `mobile-drawer-item ${isActive ? 'active' : ''}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <span className="mobile-nav-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <nav className="mobile-nav">
        <div className="mobile-nav-items">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}
            >
              <span className="mobile-nav-icon">{item.icon}</span>
              <span>{item.mobileLabel || item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </>
  );
}
