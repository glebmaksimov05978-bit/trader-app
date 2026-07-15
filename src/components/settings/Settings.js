// src/components/settings/Settings.js
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { availableTimeframes } from '../../services/marketData/candles';
import toast from 'react-hot-toast';

export default function Settings() {
  const { userProfile, updateUserProfile } = useAuth();
  const [form, setForm] = useState({
    displayName: '',
    tinkoffToken: '',
    depositSize: '',
    maxRiskPerTrade: '',
    dailyLossLimit: '',
    askJournalExtra: true,
    preferredTimeframe: '', // '' = авто по длительности сделки
  });
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [askExtra, setAskExtra] = useState(null); // null = не загружен ещё

  useEffect(() => {
    if (userProfile) {
      setForm(f => ({
        ...f,
        displayName: userProfile.displayName || '',
        tinkoffToken: userProfile.tinkoffToken || '',
        depositSize: String(userProfile.depositSize ?? 0),
        maxRiskPerTrade: String(userProfile.maxRiskPerTrade || 1),
        dailyLossLimit: String(userProfile.dailyLossLimit || 3),
        preferredTimeframe: userProfile.preferredTimeframe || '',
      }));
      // askExtra инициализируем только один раз
      if (askExtra === null) {
        setAskExtra(userProfile.askJournalExtra === true);
      }
    }
  }, [userProfile]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await updateUserProfile({
        displayName: form.displayName,
        tinkoffToken: form.tinkoffToken,
        depositSize: parseFloat(form.depositSize),
        maxRiskPerTrade: parseFloat(form.maxRiskPerTrade),
        dailyLossLimit: parseFloat(form.dailyLossLimit),
        askJournalExtra: askExtra === true,
        preferredTimeframe: form.preferredTimeframe || null,
      });
      toast.success('Настройки сохранены');
    } catch (e) {
      // Swallowing the real reason here is exactly what made a past failed save (empty
      // strategy write) impossible to diagnose without a temporary console.log — always
      // surface e.message (see project-testing-conventions memory).
      toast.error('Ошибка сохранения: ' + (e.message || 'неизвестная ошибка'));
    }
    setSaving(false);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">⚙️ Настройки</h1>
        <p className="page-subtitle">Профиль и интеграции</p>
      </div>

      <div style={{maxWidth: 600}}>
        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">👤</div>
            Профиль
          </div>
          <div className="flex flex-col gap-3">
            <div className="input-group">
              <label className="input-label">Имя</label>
              <input className="input" value={form.displayName}
                onChange={e => set('displayName', e.target.value)} placeholder="Имя трейдера"/>
            </div>
            {/* A single "Сохранить все настройки" button at the very bottom of a long
                page was easy to miss — the trader looked for a save control right next
                to the field they'd just edited and didn't find one (real user report). */}
            <button className="btn btn-secondary btn-sm" onClick={save} disabled={saving} style={{alignSelf:'flex-start'}}>
              {saving ? <><div className="spinner" style={{width:12,height:12}}/> Сохранение...</> : '💾 Сохранить имя'}
            </button>
          </div>
        </div>

        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">🔑</div>
            Tinkoff Invest API
          </div>
          <p className="text-sm text-secondary" style={{marginBottom:12}}>
            Токен используется для подгрузки цен, параметров фьючерсов и импорта сделок из Тинькофф.
            Получить можно в <a href="https://www.tinkoff.ru/invest/" target="_blank" rel="noreferrer" style={{color:'var(--accent-primary)'}}>личном кабинете Т-Инвестиций</a>.
          </p>
          <div className="input-group">
            <label className="input-label">API токен</label>
            <div className="pass-wrap" style={{position:'relative'}}>
              <input
                className="input"
                type={showToken ? 'text' : 'password'}
                value={form.tinkoffToken}
                onChange={e => set('tinkoffToken', e.target.value)}
                placeholder="t.xxx..."
                style={{paddingRight:44}}
              />
              <button
                type="button"
                style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:16}}
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? '🙈' : '👁'}
              </button>
            </div>
            <div className="input-hint">Токен хранится в вашем профиле Firestore, не передаётся третьим лицам</div>
          </div>
        </div>

        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">📊</div>
            Торговые параметры
          </div>
          <div className="flex flex-col gap-3">
            <div className="input-group">
              <label className="input-label">Размер депозита (₽)</label>
              <input className="input" type="number" value={form.depositSize}
                onChange={e => set('depositSize', e.target.value)}/>
            </div>
            <div className="input-group">
              <label className="input-label">Риск на сделку (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.1" value={form.maxRiskPerTrade}
                  onChange={e => set('maxRiskPerTrade', e.target.value)}/>
              </div>
            </div>
            <div className="input-group">
              <label className="input-label">Дневной лимит убытка (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.5" value={form.dailyLossLimit}
                  onChange={e => set('dailyLossLimit', e.target.value)}/>
              </div>
            </div>
            <div className="input-group">
              <label className="input-label">Приоритетный таймфрейм анализа</label>
              <select className="input" value={form.preferredTimeframe} onChange={e => set('preferredTimeframe', e.target.value)}>
                <option value="">Автоматически (по длительности сделки)</option>
                {availableTimeframes(!!form.tinkoffToken).map(tf => (
                  <option key={tf.key} value={tf.key}>{tf.label}</option>
                ))}
              </select>
              <div className="input-hint">
                Технический анализ в Журнале/Радаре/Калькуляторе по умолчанию будет открываться на этом
                таймфрейме. Можно всегда переключить вручную у конкретной сделки — это только стартовый выбор.
              </div>
            </div>
          </div>
        </div>


        <div className="card" style={{marginBottom:20}}>
          <div className="section-title">
            <div className="section-title-icon">📓</div>
            Журнал сделок
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 0'}}>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:'var(--text-primary)'}}>Запрашивать детали при сохранении</div>
              <div style={{fontSize:12,color:'var(--text-muted)',marginTop:2}}>Эмоция, стратегия и заметки при нажатии "В журнал"</div>
            </div>
            <button
              onClick={async () => {
                const newVal = !askExtra;
                setAskExtra(newVal);
                try {
                  await updateUserProfile({ askJournalExtra: newVal });
                  toast.success(newVal ? 'Детали будут запрашиваться' : 'Детали не будут запрашиваться');
                } catch { toast.error('Ошибка сохранения'); }
              }}
              style={{
                width:48, height:26, borderRadius:13, border:'none', cursor:'pointer',
                background: askExtra ? 'var(--accent-primary)' : 'var(--bg-surface-3)',
                position:'relative', transition:'background 0.2s', flexShrink:0,
              }}
            >
              <div style={{
                width:20, height:20, borderRadius:'50%', background:'#fff',
                position:'absolute', top:3,
                left: askExtra ? 25 : 3,
                transition:'left 0.2s',
                boxShadow:'0 1px 4px rgba(0,0,0,0.3)',
              }}/>
            </button>
          </div>
        </div>

        <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
          {saving ? <><div className="spinner" style={{width:16,height:16}}/> Сохранение...</> : '💾 Сохранить все настройки'}
        </button>
      </div>
    </div>
  );
}
