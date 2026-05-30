// src/App.js
import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './components/auth/LoginPage';
import Dashboard from './components/dashboard/Dashboard';
import Calculator from './components/calculator/Calculator';
import Journal from './components/journal/Journal';
import Capital from './components/capital/Capital';
import Advisor from './components/advisor/Advisor';
import Settings from './components/settings/Settings';
import AdminPanel from './components/admin/AdminPanel';
import './styles/globals.css';

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-logo">TraderPro</div>
      <div className="loading-bar">
        <div className="loading-bar-fill" />
      </div>
      <div className="loading-dots">
        <div className="loading-dot" />
        <div className="loading-dot" />
        <div className="loading-dot" />
      </div>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminRoute({ children }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingScreen />;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="calculator" element={<Calculator />} />
        <Route path="journal" element={<Journal />} />
        <Route path="capital" element={<Capital />} />
        <Route path="advisor" element={<Advisor />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={
          <AdminRoute><AdminPanel /></AdminRoute>
        } />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: 'var(--bg-surface-3)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-medium)',
                borderRadius: '12px',
                fontSize: '13px',
                fontFamily: 'Inter, sans-serif',
              },
              success: { iconTheme: { primary: '#10b981', secondary: '#fff' } },
              error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
            }}
          />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
