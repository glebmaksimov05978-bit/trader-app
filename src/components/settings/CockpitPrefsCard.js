// src/components/settings/CockpitPrefsCard.js
//
// Настройки → Сопровождение: вид рабочего места под себя. Сохраняется сразу в профиль (`cockpitPrefs`), отдельно от
// общей кнопки «Сохранить все настройки».
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Icon from '../shared/Icon';
import { getCockpitPrefs, COCKPIT_PREFS_DEFAULT } from '../../services/cockpitPrefs';

const Check = ({ checked, onChange, label, hint }) => (
  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 14 }}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
    <span>{label}{hint && <span className="text-sm text-muted" style={{ display: 'block' }}>{hint}</span>}</span>
  </label>
);

const Seg = ({ value, options, onChange }) => (
  <div className="mr-seg" style={{ display: 'inline-flex' }}>
    {options.map(([id, label]) => (
      <button key={id} type="button" className={value === id ? 'on' : ''} onClick={() => onChange(id)}>{label}</button>
    ))}
  </div>
);

export default function CockpitPrefsCard({ userProfile, updateUserProfile }) {
  const [p, setP] = useState(() => getCockpitPrefs(userProfile));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setP(getCockpitPrefs(userProfile)); }, [userProfile]);
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));

  const save = async (next = p) => {
    setSaving(true);
    try {
      await updateUserProfile({ cockpitPrefs: next });
      toast.success('Вид Сопровождения сохранён');
    } catch (e) {
      toast.error('Не удалось сохранить: ' + (e.message || 'ошибка'));
    }
    setSaving(false);
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title">
        <div className="section-title-icon"><Icon name="cockpit" size={15} /></div>
        Вид Сопровождения
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div className="input-label" style={{ marginBottom: 8 }}>Списки слева</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Check checked={p.showPositions} onChange={(v) => set('showPositions', v)} label="Мои позиции" hint="реальные и пробные сделки" />
            <Check checked={p.showPaper} onChange={(v) => set('showPaper', v)} label="Сделки системы" />
            {p.showPaper && <div style={{ marginLeft: 26 }}><Check checked={p.paperOpen} onChange={(v) => set('paperOpen', v)} label="Сразу раскрыты" /></div>}
            <Check checked={p.showRadar} onChange={(v) => set('showRadar', v)} label="Радар" hint="если скрыт — робот и обзор всё равно его видят" />
          </div>
        </div>
        <div>
          <div className="input-label" style={{ marginBottom: 8 }}>Высота графика</div>
          <Seg value={p.chartHeight} onChange={(v) => set('chartHeight', v)} options={[['compact', 'Компактный'], ['normal', 'Обычный'], ['tall', 'Высокий']]} />
        </div>
        <div>
          <div className="input-label" style={{ marginBottom: 8 }}>Под графиком сначала открывается</div>
          <Seg value={p.firstTab} onChange={(v) => set('firstTab', v)} options={[['auto', 'Позиция / Вход'], ['ta', 'Тех. анализ']]} />
        </div>
        <div>
          <div className="input-label" style={{ marginBottom: 8 }}>Панель управления позицией и заявки</div>
          <Seg value={p.orderPanel} onChange={(v) => set('orderPanel', v)} options={[['right', 'Справа от графика'], ['below', 'Под графиком']]} />
          <div className="text-sm text-muted" style={{ marginTop: 6 }}>Справа — на широком экране; на узком она всё равно встаёт под график.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => save()} disabled={saving}>{saving ? 'Сохраняю…' : 'Сохранить вид'}</button>
          <button className="btn btn-ghost" onClick={() => { setP({ ...COCKPIT_PREFS_DEFAULT }); save({ ...COCKPIT_PREFS_DEFAULT }); }} disabled={saving}>Как было по умолчанию</button>
        </div>
      </div>
    </div>
  );
}
