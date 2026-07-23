// src/App.js
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './components/auth/LoginPage';
import EmailNotVerifiedPage from './components/auth/EmailNotVerifiedPage';
import Dashboard from './components/dashboard/Dashboard';
import Calculator from './components/calculator/Calculator';
import Journal from './components/journal/Journal';
import Capital from './components/capital/Capital';
import Advisor from './components/advisor/Advisor';
import Settings from './components/settings/Settings';
import AdminPanel from './components/admin/AdminPanel';
import Backtest from './components/backtest/Backtest';
import LoadingScreen from './components/LoadingScreen';
import { TRUSTED_UIDS } from './constants/trustedUids';
import './styles/globals.css';

function ProtectedRoute({ children }) {
  const { user, loading, isEmailVerified } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  // Если почта не подтверждена и это не доверенный старый аккаунт — показываем экран верификации
  if (!isEmailVerified && !TRUSTED_UIDS.includes(user.uid)) {
    return <EmailNotVerifiedPage />;
  }
  return children;
}

function AdminRoute({ children }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

// Бэктест — внутренний инструмент, пока не для клиентов (см. решение "сначала своя
// калибровка, потом клиентский UI"). Открыт админам и доверенным аккаунтам.
function TrustedRoute({ children }) {
  const { user, isAdmin, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!isAdmin && !TRUSTED_UIDS.includes(user?.uid)) return <Navigate to="/" replace />;
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
        <Route path="backtest" element={
          <TrustedRoute><Backtest /></TrustedRoute>
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
              error:   { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
            }}
          />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
