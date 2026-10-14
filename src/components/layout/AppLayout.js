// src/components/layout/AppLayout.js
import React, { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import EmailVerifyBanner from './EmailVerifyBanner';
import { RadarLiveProvider } from '../../context/RadarLiveContext';
import './AppLayout.css';

export default function AppLayout() {
  // Клик (или касание) мимо раскрытого меню профиля закрывает его. Меню живёт в боковой панели и
  // само за кликами снаружи не следило; закрываем тем же нажатием на его кнопку, чтобы не
  // дублировать состояние панели здесь.
  useEffect(() => {
    const onOutside = (e) => {
      const dd = document.querySelector('.profile-dropdown');
      if (!dd) return;
      if (e.target.closest?.('.profile-section')) return;
      document.querySelector('.profile-btn')?.click();
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
    };
  }, []);

  // RadarLiveProvider lives here, above <Outlet/> — this is the one part of the tree
  // that stays mounted across route changes, so the Radar polling timer survives
  // navigating to another page instead of dying with the Dashboard component that used
  // to own it (real user report: "live режим спадает при переключении на другие
  // вкладки").
  return (
    <RadarLiveProvider>
      <div className="app-layout">
        <div className="app-bg" />
        <Sidebar />
        <main className="main-content">
          <EmailVerifyBanner />
          <Outlet />
        </main>
        <MobileNav />
      </div>
    </RadarLiveProvider>
  );
}
