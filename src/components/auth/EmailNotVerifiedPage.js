// src/components/auth/EmailNotVerifiedPage.js
import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

export default function EmailNotVerifiedPage() {
  const { user, resendVerificationEmail, refreshEmailVerified, logout } = useAuth();
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleResend = async () => {
    setSending(true);
    try {
      await resendVerificationEmail();
      toast.success('Письмо отправлено повторно — проверьте папку «Спам»');
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
        toast.success('Почта подтверждена! Добро пожаловать ✅');
        // Страница перезагрузится автоматически через onAuthStateChanged
      } else {
        toast.error('Почта ещё не подтверждена — проверьте письмо');
      }
    } catch {
      toast.error('Ошибка проверки');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{
      position:'fixed', inset:0,
      display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg-primary)', padding:20,
    }}>
      {/* Фоновые глоу-пятна */}
      <div style={{position:'absolute',inset:0,pointerEvents:'none',overflow:'hidden'}}>
        <div style={{position:'absolute',top:'20%',left:'30%',width:400,height:400,borderRadius:'50%',background:'rgba(79,70,229,0.06)',filter:'blur(80px)'}}/>
        <div style={{position:'absolute',bottom:'20%',right:'20%',width:300,height:300,borderRadius:'50%',background:'rgba(245,158,11,0.05)',filter:'blur(60px)'}}/>
      </div>

      <div style={{
        width:'100%', maxWidth:480, position:'relative',
        display:'flex', flexDirection:'column', alignItems:'center',
        textAlign:'center',
      }}>
        {/* Иконка */}
        <div style={{
          width:72, height:72, borderRadius:20,
          background:'rgba(245,158,11,0.12)',
          border:'1px solid rgba(245,158,11,0.3)',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:36, marginBottom:20,
        }}>📧</div>

        <h1 style={{
          fontSize:24, fontWeight:700, color:'var(--text-primary)',
          marginBottom:8, letterSpacing:'-0.5px',
        }}>Подтвердите почту</h1>

        <p style={{
          fontSize:14, color:'var(--text-secondary)',
          lineHeight:1.7, marginBottom:8, maxWidth:360,
        }}>
          Мы отправили письмо со ссылкой на
        </p>
        <div style={{
          background:'var(--bg-surface-2)',
          border:'1px solid var(--border-medium)',
          borderRadius:10, padding:'8px 16px',
          fontSize:14, fontWeight:600, color:'var(--text-primary)',
          marginBottom:24,
        }}>
          {user?.email}
        </div>

        <p style={{
          fontSize:13, color:'var(--text-muted)',
          marginBottom:24, maxWidth:340,
        }}>
          Перейдите по ссылке в письме — после этого нажмите кнопку ниже. Если письмо не пришло, проверьте папку «Спам».
        </p>

        {/* Кнопки */}
        <div style={{display:'flex', flexDirection:'column', gap:10, width:'100%', maxWidth:340}}>
          <button
            onClick={handleCheck}
            disabled={checking}
            style={{
              padding:'13px', border:'none', borderRadius:14,
              background:'var(--accent-gradient)',
              color:'#fff', fontFamily:'inherit',
              fontSize:15, fontWeight:700, cursor:'pointer',
              boxShadow:'0 4px 16px rgba(79,70,229,0.3)',
              opacity: checking ? 0.7 : 1,
            }}
          >
            {checking ? 'Проверяем...' : '✅ Я подтвердил почту'}
          </button>

          <button
            onClick={handleResend}
            disabled={sending}
            style={{
              padding:'12px', border:'1px solid var(--border-medium)',
              borderRadius:14, background:'var(--bg-surface-2)',
              color:'var(--text-primary)', fontFamily:'inherit',
              fontSize:14, fontWeight:500, cursor:'pointer',
              opacity: sending ? 0.7 : 1,
            }}
          >
            {sending ? 'Отправляем...' : '📨 Отправить письмо повторно'}
          </button>

          <button
            onClick={logout}
            style={{
              padding:'10px', border:'none',
              background:'none', color:'var(--text-muted)',
              fontFamily:'inherit', fontSize:13,
              cursor:'pointer', marginTop:4,
            }}
          >
            Выйти из аккаунта
          </button>
        </div>
      </div>
    </div>
  );
}
