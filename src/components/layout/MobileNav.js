// src/components/layout/MobileNav.js
import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { TRUSTED_UIDS } from '../../constants/trustedUids';
import { NAV_ITEMS, ADMIN_ITEMS, TRUSTED_ITEMS } from '../../constants/navItems';
import './Sidebar.css';

// Real user report on the FIRST version of this (bottom bar + hamburger for extras
// only): the hamburger button was fixed-position over page content and partially
// covered the "Дашборд" heading, and the drawer only ever held Бэктест — confusing,
// looked broken. Redesigned per the trader's own original ask: no bottom bar on mobile
// at all, a slim top bar with the hamburger is the only mobile chrome, and the drawer
// holds the FULL nav (not just the trusted-only extras) — Sidebar.css gives
// .main-content top padding on mobile so page content never sits under the bar.
export default function MobileNav() {
  const { user, isAdmin } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isTrusted = isAdmin || TRUSTED_UIDS.includes(user?.uid);
  const items = [
    ...NAV_ITEMS,
    ...(isTrusted ? TRUSTED_ITEMS : []),
    ...(isAdmin ? ADMIN_ITEMS : []),
  ];

  return (
    <>
      <div className="mobile-topbar">
        <button className="mobile-hamburger" onClick={() => setDrawerOpen(true)} aria-label="Меню">☰</button>
        <span className="mobile-topbar-title">TraderPro</span>
      </div>
      {drawerOpen && (
        <div className="mobile-drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <div className="mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-drawer-header">
              <span>Меню</span>
              <button className="mobile-drawer-close" onClick={() => setDrawerOpen(false)}>✕</button>
            </div>
            {items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
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
  );
}
