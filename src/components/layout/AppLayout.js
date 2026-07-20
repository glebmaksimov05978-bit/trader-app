// src/components/layout/AppLayout.js
import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import EmailVerifyBanner from './EmailVerifyBanner';
import { RadarLiveProvider } from '../../context/RadarLiveContext';
import './AppLayout.css';

export default function AppLayout() {
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
