// src/components/layout/AppLayout.js
import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import './AppLayout.css';

export default function AppLayout() {
  return (
    <div className="app-layout">
      <div className="app-bg" />
      <Sidebar />
      <main className="main-content">
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
}
