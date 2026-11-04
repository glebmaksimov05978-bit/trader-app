// Проверка обучающих туров (npm run test:smoke): самозапуск новичку, листание, «Пропустить», тур раздела при первом
// заходе, «Больше не показывать», подсветка найденного элемента, кнопка действия, ручной запуск и клавиша Esc.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, useLocation } from 'react-router-dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockAuth = { current: null };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth.current }));

const { OnboardingProvider, useOnboarding } = require('./OnboardingContext');
const { TOURS } = require('./tours');

const sleep = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = (el) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const byText = (text) => [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const dialog = () => document.body.querySelector('[role="dialog"]');

function Where() { const l = useLocation(); return <span data-testid="where">{l.pathname}</span>; }
function HelpButton() { const { startForPath } = useOnboarding(); return <button id="help" onClick={startForPath}>help</button>; }

function Harness({ profile, path = '/calculator', saves }) {
  const [p, setP] = useState(profile);
  mockAuth.current = {
    user: { uid: 'u1' },
    userProfile: p,
    updateUserProfile: async (d) => { saves.push(d); setP((prev) => ({ ...prev, ...d })); },
  };
  return (
    <MemoryRouter initialEntries={[path]}>
      <OnboardingProvider autoStartDelay={20}>
        <Where /><HelpButton />
        <nav className="sidebar-nav"><a href="/calculator">Калькулятор</a></nav>
      </OnboardingProvider>
    </MemoryRouter>
  );
}

let host, root;
async function mount(profile, opts = {}) {
  const saves = [];
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness profile={profile} saves={saves} {...opts} />); });
  return saves;
}
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

const newcomer = { role: 'free', onboarding: { eligible: true } };

test('новичку сам открывается общий тур; «Далее» листает; «Пропустить» запоминает', async () => {
  const saves = await mount(newcomer);
  expect(dialog()).toBeNull();            // сразу не показываем — даём странице отрисоваться
  await sleep(80);
  expect(dialog()).not.toBeNull();
  expect(dialog().textContent).toContain('Добро пожаловать');
  expect(dialog().textContent).toContain(`1 из ${TOURS.general.steps.length}`);
  click(byText('Далее'));
  await sleep(20);
  expect(dialog().textContent).toContain('2 из');
  expect(dialog().textContent).toContain('Калькулятор');
  click(byText('Пропустить'));
  await sleep(20);
  expect(saves.length).toBe(1);
  expect(saves[0].onboarding.done.general).toBeTruthy();
  expect(saves[0].onboarding.eligible).toBe(true);   // старые поля не теряются при записи
});

test('после общего тура при первом заходе в раздел показывается тур раздела, потом не повторяется', async () => {
  const saves = await mount({ ...newcomer, onboarding: { eligible: true, done: { general: 1 } } });
  await sleep(80);
  expect(dialog()).not.toBeNull();
  expect(dialog().textContent).toContain('Калькулятор сделки');
  click(byText('✕'));                    // закрыли крестиком = пропустили
  await sleep(80);
  expect(dialog()).toBeNull();
  expect(saves[0].onboarding.done.calculator).toBeTruthy();
  expect(saves[0].onboarding.done.general).toBe(1);
  await sleep(80);
  expect(dialog()).toBeNull();           // не повторяется
});

test('старому пользователю (без eligible) туры сами не появляются', async () => {
  await mount({ role: 'free' });
  await sleep(100);
  expect(dialog()).toBeNull();
});

test('«Больше не показывать подсказки» отключает самозапуск', async () => {
  const saves = await mount(newcomer);
  await sleep(80);
  click(byText('Больше не показывать подсказки'));
  await sleep(40);
  expect(dialog()).toBeNull();
  expect(saves.some((s) => s.onboarding.disabled === true)).toBe(true);
  await sleep(100);
  expect(dialog()).toBeNull();
});

test('найденный элемент подсвечивается, не найденный — шаг по центру', async () => {
  await mount(newcomer);
  const a = document.querySelector('.sidebar-nav a');
  a.getBoundingClientRect = () => ({ top: 100, left: 20, width: 180, height: 40, right: 200, bottom: 140, x: 20, y: 100 });
  await sleep(80);
  expect(document.body.querySelector('.tour-spot')).toBeNull();   // первый шаг без цели
  expect(document.body.querySelector('.tour-dim')).not.toBeNull();
  click(byText('Далее'));                                         // шаг про «Калькулятор» — цель найдена
  await sleep(300);
  const spot = document.body.querySelector('.tour-spot');
  expect(spot).not.toBeNull();
  expect(spot.style.width).toBe('196px');                         // 180 + по 8 с каждой стороны
  click(byText('Далее'));                                         // «Журнал»: ссылки нет в тесте → по центру
  await sleep(1700);
  expect(document.body.querySelector('.tour-spot')).toBeNull();
  expect(dialog().textContent).toContain('Журнал');
});

test('на последнем шаге кнопка действия ведёт в раздел и закрывает тур', async () => {
  const saves = await mount(newcomer);
  await sleep(80);
  const n = TOURS.general.steps.length;
  for (let i = 0; i < n - 1; i++) { click(byText('Далее')); await sleep(10); }
  expect(dialog().textContent).toContain('С чего начать');
  click(byText('Открыть Капитал'));
  await sleep(30);
  expect(document.querySelector('[data-testid="where"]').textContent).toBe('/capital');
  expect(saves[0].onboarding.done.general).toBeTruthy();
});

test('кнопка «Подсказки» запускает тур текущего раздела; Esc закрывает', async () => {
  await mount({ role: 'free', onboarding: { eligible: false } });
  await sleep(40);
  expect(dialog()).toBeNull();
  click(document.querySelector('#help'));
  await sleep(20);
  expect(dialog().textContent).toContain('Калькулятор сделки');
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await sleep(20);
  expect(dialog()).toBeNull();
});
