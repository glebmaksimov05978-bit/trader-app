// src/components/layout/EmailVerifyBanner.js
import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

export default function EmailVerifyBanner() {
  const { user, isEmailVerified, resendVerificationEmail, refreshEmailVerified } = useAuth();
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (!user || isEmailVerified || dismissed) return null;

  const handleResend = async () => {
    setSending(true);
    try {
      await resendVerificationEmail();
      toast.success('Письмо отправлено повторно');
    } catch (e) {
      toast.error(e.message || 'Не удалось отправить письмо');
    } finally {
      setSending(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      const verified = await refreshEmailVerified();
      if (verified) {
        toast.success('Почта подтверждена ✅');
      } else {
        toast.error('Почта пока не подтверждена');
      }
    } catch {
      toast.error('Ошибка проверки');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      gap:12, flexWrap:'wrap',
      background:'rgba(245,158,11,0.1)',
      borderBottom:'1px solid rgba(245,158,11,0.3)',
      padding:'10px 20px',
      fontSize:13,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:8, color:'var(--gold)'}}>
        <span>📧</span>
        <span>Подтвердите почту <strong>{user.email}</strong> — мы отправили письмо со ссылкой</span>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:8}}>
        <button
          onClick={handleCheck}
          disabled={checking}
          style={{
            background:'var(--bg-surface-2)', border:'1px solid var(--border-medium)',
            borderRadius:8, padding:'6px 12px', fontSize:12, fontFamily:'inherit',
            color:'var(--text-primary)', cursor:'pointer',
          }}
        >
          {checking ? '...' : 'Я подтвердил'}
        </button>
        <button
          onClick={handleResend}
          disabled={sending}
          style={{
            background:'var(--gold)', border:'none',
            borderRadius:8, padding:'6px 12px', fontSize:12, fontFamily:'inherit',
            color:'#1a1a1a', fontWeight:600, cursor:'pointer',
          }}
        >
          {sending ? 'Отправка...' : 'Отправить письмо'}
        </button>
        <button
          onClick={() => setDismissed(true)}
          style={{
            background:'none', border:'none', cursor:'pointer',
            color:'var(--text-muted)', fontSize:16, padding:'2px 4px',
          }}
        >✕</button>
      </div>
    </div>
  );
}
