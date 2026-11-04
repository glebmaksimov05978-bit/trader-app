// Проверка элементов управления страницы «Отчёт»: переключатель периода и фильтр стратегий
// (npm run test:smoke). Нажимаем кнопки по-настоящему в тестовом браузере.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { PeriodSwitcher, StrategyFilter } from './ReportControls';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(element) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(element); });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
const click = (el) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const byLabel = (host, label) => host.querySelector(`[aria-label="${label}"]`);

const periods = [
  { key: '2026-10', label: 'Октябрь 2026' },
  { key: '2026-09', label: 'Сентябрь 2026' },
  { key: '2025-12', label: 'Декабрь 2025' },
];

test('период: стрелки ведут к соседним периодам, у крайних — выключены', () => {
  const calls = [];
  const m = mount(<PeriodSwitcher periods={periods} value="2026-10" type="month" onChange={(k) => calls.push(k)} />);
  const older = byLabel(m.host, 'Более ранний период');
  const newer = byLabel(m.host, 'Более поздний период');
  expect(newer.disabled).toBe(true);        // свежее октября данных нет
  expect(older.disabled).toBe(false);
  click(older);
  expect(calls).toEqual(['2026-09']);
  m.unmount();
});

test('период: окно показывает годы, месяцы без данных выключены, выбор вызывает onChange и закрывает окно', () => {
  const calls = [];
  const m = mount(<PeriodSwitcher periods={periods} value="2026-10" type="month" onChange={(k) => calls.push(k)} />);
  expect(m.host.querySelector('.mr-period-pop')).toBeNull();
  click(m.host.querySelector('.mr-period-label'));
  const pop = m.host.querySelector('.mr-period-pop');
  expect(pop).not.toBeNull();
  const titles = [...pop.querySelectorAll('.mr-pop-year-title')].map((x) => x.textContent);
  expect(titles).toEqual(['2026', '2025']);
  const cells = [...pop.querySelectorAll('.mr-pop-cell')];
  const enabled = cells.filter((c) => !c.disabled);
  expect(enabled.length).toBe(3);           // сентябрь и октябрь 2026, декабрь 2025
  expect(pop.querySelector('.mr-pop-cell.on').textContent).toBe('Окт');
  click(enabled[enabled.length - 1]);       // декабрь 2025
  expect(calls).toEqual(['2025-12']);
  expect(m.host.querySelector('.mr-period-pop')).toBeNull();
  m.unmount();
});

test('период: Escape закрывает окно; для года — список лет; без данных — кнопка выключена', () => {
  const m = mount(<PeriodSwitcher periods={periods} value="2026-10" type="month" onChange={() => {}} />);
  click(m.host.querySelector('.mr-period-label'));
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(m.host.querySelector('.mr-period-pop')).toBeNull();
  m.unmount();

  const y = mount(<PeriodSwitcher periods={[{ key: '2026', label: '2026 год' }, { key: '2025', label: '2025 год' }]} value="2026" type="year" onChange={() => {}} />);
  click(y.host.querySelector('.mr-period-label'));
  expect([...y.host.querySelectorAll('.mr-pop-cell')].map((c) => c.textContent)).toEqual(['2026 год', '2025 год']);
  y.unmount();

  const e = mount(<PeriodSwitcher periods={[]} value={undefined} type="month" onChange={() => {}} />);
  expect(e.host.querySelector('.mr-period-label').disabled).toBe(true);
  expect(e.host.textContent).toContain('Нет данных');
  e.unmount();
});

const names = [{ name: 'Пробой', count: 7 }, { name: 'Откат', count: 4 }];

test('фильтр стратегий: «Все» по умолчанию, выбор одной, выбор обеих = «Все»', () => {
  const calls = [];
  const m = mount(<StrategyFilter names={names} selected={[]} onChange={(v) => calls.push(v)} />);
  const chips = () => [...m.host.querySelectorAll('.mr-chip')];
  expect(chips().map((c) => c.textContent.replace(/\d+$/, ''))).toEqual(['Все', 'Пробой', 'Откат']);
  expect(chips()[0].getAttribute('aria-pressed')).toBe('true');
  click(chips()[1]);
  expect(calls).toEqual([['Пробой']]);
  m.unmount();

  const calls2 = [];
  const m2 = mount(<StrategyFilter names={names} selected={['Пробой']} onChange={(v) => calls2.push(v)} />);
  const c2 = [...m2.host.querySelectorAll('.mr-chip')];
  expect(c2[1].getAttribute('aria-pressed')).toBe('true');
  expect(c2[0].getAttribute('aria-pressed')).toBe('false');
  click(c2[2]);                              // добавили вторую — отмечены обе, это то же, что «Все»
  expect(calls2).toEqual([[]]);
  click(c2[1]);                              // сняли отметку с единственной выбранной → пустой выбор = все
  expect(calls2[1]).toEqual([]);
  m2.unmount();
});

test('фильтр стратегий не показывается, если стратегия одна', () => {
  const m = mount(<StrategyFilter names={[{ name: 'Пробой', count: 3 }]} selected={[]} onChange={() => {}} />);
  expect(m.host.querySelector('.mr-filter')).toBeNull();
  m.unmount();
});
