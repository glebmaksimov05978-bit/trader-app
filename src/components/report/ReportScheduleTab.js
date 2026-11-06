// src/components/report/ReportScheduleTab.js
//
// Вкладка «По расписанию» в окне «Выгрузить отчёт»: список расписаний автоотправки и форма настройки (когда слать, за какой
// период, что внутри). Расписания лежат в профиле (reportSchedules); отправляет фоновый робот (scripts/reports/runScheduledReports.mjs)
// — PDF файлом в Telegram, на почту и/или в MAX (что из этого подключено в роботе, он сообщает в профиле: reportDelivery).
// Логика «когда пора» — services/report/schedule.js.
import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Icon from '../shared/Icon';
import DatePicker from '../shared/DatePicker';
import confirmDialog from '../shared/confirmDialog';
import { deviceZone } from '../../services/report/deviceZone';
import { SCOPES } from '../../services/analytics/periodReport';
import { SECTIONS } from '../../services/report/exportReport';
import {
  FREQUENCIES, MSK_TZ, hoursForZone, utcLabel, findDuplicate, SCHEDULE_PERIODS, MAX_SCHEDULES, CHANNELS, defaultSchedule, normalizeSchedule, normalizeSchedules, describeSchedule, describeChannels, periodWords,
  nextRunAt, mismatchHint, mskParts, isValidEmail, manualPending,
} from '../../services/report/schedule';

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const PERIOD_LABEL = { last_week: 'Прошлая неделя', this_week: 'Эта неделя (с понедельника)', last_month: 'Прошлый месяц', this_month: 'Этот месяц (с 1-го числа)', last_quarter: 'Прошлый квартал', this_quarter: 'Этот квартал (с начала)', last_year: 'Прошлый год', this_year: 'Этот год (с 1 января)', last_30: 'Последние 30 дней', last_90: 'Последние 90 дней' };

// Что показываем под каждым каналом в форме: подключён ли он в роботе (робот сам сообщает об этом в профиль).
function channelState(ch, delivery) {
  if (ch === 'telegram') return null;
  const v = delivery?.[ch];
  if (v === true) return { cls: 'ok', text: 'Подключено в роботе.' };
  if (v === false) return { cls: 'bad', text: ch === 'email'
    ? 'В роботе пока нет ключей почты — письма не уйдут, пока они не добавлены (см. инструкцию в ЧТО_ПРОВЕРИТЬ, п. 11).'
    : 'Бот MAX в роботе пока не подключён — сообщения не уйдут, пока не добавлены токен бота и ваш номер в MAX (см. инструкцию в ЧТО_ПРОВЕРИТЬ, п. 11).' };
  return { cls: '', text: 'Статус подключения появится после ближайшего запуска робота.' };
}

const dateText = (ms, tz) => {
  const p = mskParts(ms, tz);
  return `${p.d} ${MONTHS_GEN[p.m]}, ${String(p.hour).padStart(2, '0')}:${String(new Date(ms).getUTCMinutes()).padStart(2, '0')}`;
};
const dayText = (ms, tz) => { const p = mskParts(ms, tz); return `${p.d} ${MONTHS_GEN[p.m]} ${p.y}`; };

const zoneTitle = (tz) => (tz === MSK_TZ ? 'по Москве' : `${utcLabel(tz)}, ${String(tz).split('/').pop().replace(/_/g, ' ')}`);

export default function ReportScheduleTab({ profile, updateUserProfile, strategyList = [], defaultSections }) {
  const list = useMemo(() => normalizeSchedules(profile?.reportSchedules), [profile?.reportSchedules]);
  const log = profile?.reportSendLog || {};
  const delivery = profile?.reportDelivery || null;
  const [editing, setEditing] = useState(null);   // расписание в форме
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  async function save(next) {
    setBusy(true);
    try { await updateUserProfile({ reportSchedules: next }); return true; }
    catch (e) { toast.error(`Не удалось сохранить: ${e?.message || 'ошибка'}`); return false; }
    finally { setBusy(false); }
  }

  const lastEmail = [...list].reverse().find((x) => x.email)?.email || '';
  const startNew = () => {
    const tz = deviceZone(); // новое расписание по умолчанию — по времени устройства
    const hours = hoursForZone(tz);
    setEditing(defaultSchedule({ ...(defaultSections ? { sections: defaultSections.slice() } : {}), email: lastEmail, tz, hour: hours.includes(9) ? 9 : hours[0] }));
    setIsNew(true);
  };
  const startEdit = (s) => { setEditing({ ...s }); setIsNew(false); };

  async function submit() {
    if ((editing.channels || []).includes('email') && !isValidEmail((editing.email || '').trim())) { toast.error('Укажите один правильный адрес почты, например name@mail.ru'); return; }
    const s = normalizeSchedule(editing);
    if (!s) { toast.error('Для разовой отправки выберите дату'); return; }
    if (s.frequency === 'once' && s.date < mskParts(Date.now(), s.tz).date) { toast.error('Дата уже прошла — выберите сегодняшнюю или будущую'); return; }
    const next = isNew ? [...list, s] : list.map((x) => (x.id === s.id ? s : x));
    if (await save(next)) { setEditing(null); toast.success('Расписание сохранено'); }
  }
  const toggle = (s) => save(list.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
  const remove = async (s) => {
    const ok = await confirmDialog({ title: 'Удалить расписание?', text: `«${s.name || describeSchedule(s)}» больше не будет присылать отчёты. Уже отправленные отчёты это не затрагивает.` });
    if (ok) await save(list.filter((x) => x.id !== s.id));
  };
  const sendNow = async (s) => {
    if (await save(list.map((x) => (x.id === s.id ? { ...x, sendNowAt: Date.now() } : x)))) toast.success(`Запрос принят: отчёт придёт (${describeChannels(s)}) в течение 15 минут`);
  };

  if (editing) {
    const e = editing;
    const set = (patch) => setEditing((cur) => ({ ...cur, ...patch }));
    const toggleSec = (id) => set({ sections: e.sections.includes(id) ? e.sections.filter((x) => x !== id) : [...e.sections, id] });
    const toggleCh = (id) => set({ channels: e.channels.includes(id) ? e.channels.filter((x) => x !== id) : [...e.channels, id] });
    const toggleStrat = (n) => set({ strategies: e.strategies.includes(n) ? e.strategies.filter((x) => x !== n) : [...e.strategies, n] });
    const hint = mismatchHint(e);
    const zones = deviceZone() === MSK_TZ ? [MSK_TZ] : [deviceZone(), MSK_TZ];
    const setZone = (z) => set({ tz: z, hour: hoursForZone(z).includes(e.hour) ? e.hour : (hoursForZone(z).includes(9) ? 9 : hoursForZone(z)[0]) });
    const norm = normalizeSchedule(e);
    const dup = norm ? findDuplicate(list, norm) : null;
    return (
      <div className="rx-body">
        <section className="rx-block">
          <h3>Название (по желанию)</h3>
          <input className="input" value={e.name} maxLength={60} placeholder="Например: Итоги недели" onChange={(ev) => set({ name: ev.target.value })} />
        </section>

        <section className="rx-block">
          <h3>Куда присылать</h3>
          <div className="rx-sections">
            {CHANNELS.map((c) => {
              const on = e.channels.includes(c.id);
              const st = channelState(c.id, delivery);
              return (
                <label key={c.id} className="rx-check">
                  <input type="checkbox" checked={on} disabled={on && e.channels.length === 1} onChange={() => toggleCh(c.id)} />
                  <span><b>{c.label}</b><small>{c.hint}</small>{on && st && <small className={st.cls ? `rx-chstate ${st.cls}` : 'rx-chstate'}>{st.text}</small>}</span>
                </label>
              );
            })}
          </div>
          {e.channels.includes('email') && (
            <label className="rx-email">Адрес почты
              <input type="email" className="input" value={e.email} maxLength={120} placeholder="name@mail.ru" autoComplete="email" onChange={(ev) => set({ email: ev.target.value })} />
            </label>
          )}
          {e.channels.includes('max') && <p className="rx-note">Бот в MAX можно создать только на компанию, ИП или самозанятого (российского резидента) — подробности в инструкции. Если бота нет, оставьте Telegram или почту.</p>}
        </section>

        <section className="rx-block">
          <h3>Когда присылать</h3>
          <div className="rx-seg" role="tablist" aria-label="Частота">
            {FREQUENCIES.map((f) => (
              <button key={f.id} type="button" className={e.frequency === f.id ? 'on' : ''}
                onClick={() => set({ frequency: f.id, period: f.id === 'weekly' ? 'last_week' : f.id === 'monthly' ? 'last_month' : e.period })}>{f.label}</button>
            ))}
          </div>
          <div className="rx-dates">
            {e.frequency === 'weekly' && (
              <label>День <select className="input" value={e.dayOfWeek} onChange={(ev) => set({ dayOfWeek: Number(ev.target.value) })}>
                {WEEKDAY_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select></label>
            )}
            {e.frequency === 'monthly' && (
              <label>Число <select className="input" value={e.dayOfMonth} onChange={(ev) => set({ dayOfMonth: ev.target.value === 'last' ? 'last' : Number(ev.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}-е</option>)}
                <option value="last">Последний день месяца</option></select></label>
            )}
            {e.frequency === 'once' && (
              <label>Дата <DatePicker value={e.date} min={mskParts(Date.now(), e.tz).date} onChange={(v) => set({ date: v })} ariaLabel="Дата отправки" /></label>
            )}
            <label>Время <select className="input" value={e.hour} onChange={(ev) => set({ hour: Number(ev.target.value) })} aria-label="Час отправки">
              {hoursForZone(e.tz).map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
          </div>
          {zones.length > 1 ? (
            <div className="rx-seg" role="tablist" aria-label="Часовой пояс" style={{ marginTop: 8 }}>
              {zones.map((z) => (
                <button key={z} type="button" className={e.tz === z ? 'on' : ''} onClick={() => setZone(z)}>{z === MSK_TZ ? 'По Москве' : `Моё время (${zoneTitle(z)})`}</button>
              ))}
            </div>
          ) : <p className="rx-note" style={{ marginTop: 6 }}>Время указано {zoneTitle(e.tz)}.</p>}
          <p className="rx-note">Робот проверяет расписание раз в 15 минут (с 7:00 до 23:45 по Москве), поэтому файл может прийти с небольшим опозданием.</p>
        </section>

        <section className="rx-block">
          <h3>За какой период</h3>
          <select className="input" value={e.period} onChange={(ev) => set({ period: ev.target.value })} aria-label="Период отчёта">
            {SCHEDULE_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
          </select>
          <p className="rx-note">Период считается в момент отправки: «Прошлый месяц» всегда означает последний завершённый месяц.</p>
          {hint && <p className="rx-error" style={{ color: 'var(--gold)' }}>{hint}</p>}
          {dup && <p className="rx-error" style={{ color: 'var(--gold)' }}>Точно такое же расписание уже есть{dup.name ? ` («${dup.name}»)` : ''}: отчёт придёт дважды. Измените время или период — или не сохраняйте это расписание.</p>}
        </section>

        <section className="rx-block">
          <h3>Какие сделки</h3>
          <div className="rx-seg" role="tablist" aria-label="Срез">
            {SCOPES.map((s) => <button key={s.id} type="button" className={e.scope === s.id ? 'on' : ''} onClick={() => set({ scope: s.id })}>{s.label}</button>)}
          </div>
          {strategyList.length > 1 && (
            <div className="rx-chips">
              <button type="button" className={`rx-chip ${e.strategies.length === 0 ? 'on' : ''}`} onClick={() => set({ strategies: [] })}>Все стратегии</button>
              {strategyList.map((s) => <button key={s.name} type="button" className={`rx-chip ${e.strategies.includes(s.name) ? 'on' : ''}`} onClick={() => toggleStrat(s.name)}>{s.name}</button>)}
            </div>
          )}
        </section>

        <section className="rx-block">
          <h3>Что внутри</h3>
          <div className="rx-sections">
            {SECTIONS.map((s) => (
              <label key={s.id} className="rx-check">
                <input type="checkbox" checked={e.sections.includes(s.id)} onChange={() => toggleSec(s.id)} />
                <span><b>{s.label}</b><small>{s.hint}</small></span>
              </label>
            ))}
          </div>
        </section>

        <div className="rx-actions" style={{ justifyContent: 'flex-end', paddingBottom: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Отмена</button>
          <button type="button" className="btn btn-primary" disabled={busy || !e.sections.length} onClick={submit}>{busy ? 'Сохраняю…' : 'Сохранить расписание'}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rx-body">
      <div className="rx-info">
        <Icon name="send" size={15} />
        <p>Отчёт приходит <b>PDF-файлом</b>: в Telegram (тот же чат, куда приходят уведомления робота), на почту или в MAX — на выбор для каждого расписания. Вы выбираете, когда слать, за какой период и что внутри.</p>
      </div>

      {list.length === 0 && <p className="rx-note" style={{ margin: '4px 0' }}>Расписаний пока нет. Например: «каждый понедельник — итоги прошлой недели» или «1-го числа — итоги месяца».</p>}

      {list.map((s) => {
        const st = log[s.id] || {};
        const next = nextRunAt(s, now, st);
        const pending = manualPending(s, st, now);
        return (
          <article key={s.id} className={`rx-sched ${s.enabled ? '' : 'off'}`}>
            <div className="rx-sched-head">
              <div>
                <b>{s.name || describeSchedule(s)}</b>
                {s.name && <span className="rx-sched-sub">{describeSchedule(s)}</span>}
              </div>
              <label className="rx-switch" title={s.enabled ? 'Выключить' : 'Включить'}>
                <input type="checkbox" checked={s.enabled} disabled={busy} onChange={() => toggle(s)} aria-label="Включено" />
                <span />
              </label>
            </div>
            <p className="rx-sched-line">
              {s.scope === 'real' ? 'Реальные' : s.scope === 'paper' ? 'Бумажные' : 'Всё вместе'} · {s.strategies.length ? s.strategies.join(', ') : 'все стратегии'} · разделов: {s.sections.length}
            </p>
            <p className="rx-sched-line">Куда: {describeChannels(s)}</p>
            <p className="rx-sched-line">
              {!s.enabled ? 'Выключено.' : pending ? 'Запрос «Отправить сейчас» принят — придёт в течение 15 минут.' : next ? `Следующая отправка: ${next <= now + 60000 ? 'при ближайшем проходе робота (сегодня)' : dateText(next, s.tz)} · за ${periodWords(s.period)}.` : 'Больше отправок не будет.'}
            </p>
            {st.lastSentOn && !st.lastError && <p className="rx-sched-line ok">Последняя отправка: {dayText(st.lastSentAt || now, s.tz)} — «{st.lastTitle}».</p>}
            {st.lastError && <p className="rx-sched-line bad">Ошибка последней попытки: {st.lastError}. Робот повторит позже в тот же день.</p>}
            <div className="rx-sched-actions">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !s.enabled || pending} onClick={() => sendNow(s)}><Icon name="send" size={12} /> Отправить сейчас</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => startEdit(s)}><Icon name="edit" size={12} /> Изменить</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(s)}><Icon name="trash" size={12} /> Удалить</button>
            </div>
          </article>
        );
      })}

      <div>
        <button type="button" className="btn btn-primary" disabled={busy || list.length >= MAX_SCHEDULES} onClick={startNew}><Icon name="plus" size={14} /> Добавить расписание</button>
        {list.length >= MAX_SCHEDULES && <span className="rx-note" style={{ marginLeft: 10 }}>Не больше {MAX_SCHEDULES} расписаний.</span>}
      </div>
    </div>
  );
}
