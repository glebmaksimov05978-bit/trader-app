// Проверка окна «Выгрузить отчёт» (npm run test:smoke): открывается, показывает период и итог, выбор разделов и среза влияет
// на модель, кнопки запускают сборку PDF/Word и скачивание. Сами библиотеки PDF/Word в тесте заменены заглушками.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-hot-toast', () => { const t = jest.fn(); t.success = jest.fn(); t.error = jest.fn(); return { __esModule: true, default: t }; });
const mockPdf = jest.fn();
const mockDocx = jest.fn();
const mockDownload = jest.fn();
jest.mock('../../services/report/exportClient', () => ({
  buildPdfBlob: (...a) => mockPdf(...a),
  buildDocxBlob: (...a) => mockDocx(...a),
  downloadBlob: (...a) => mockDownload(...a),
  reportFileName: (m, ext) => `TraderPro_report_${m.meta.period.from}.${ext}`,
}));

const ReportExportModal = require('./ReportExportModal').default;

const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const trades = [
  { status: 'closed', pnl: 1500, closedAt: iso(40), ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой' },
  { status: 'closed', pnl: -600, closedAt: iso(38), ticker: 'GAZP', direction: 'short', entryStrategyName: 'Отскок' },
  { status: 'closed', pnl: 900, closedAt: iso(5), ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой' },
];

const click = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const byText = (text, root = document.body) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text));
const change = (el, value) => act(async () => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});

let host, root, onClose;
async function mount(props = {}) {
  onClose = jest.fn();
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ReportExportModal open onClose={onClose} realTrades={trades} paperTrades={[]} strategyList={[{ name: 'Пробой', count: 2 }, { name: 'Отскок', count: 1 }]}
      defaultScope="real" defaultStrategies={[]} pageRange={null} {...props} />);
  });
}
beforeEach(() => {
  localStorage.clear();
  mockPdf.mockReset(); mockDocx.mockReset(); mockDownload.mockReset();
  mockPdf.mockImplementation(async () => new Blob(['pdf']));
  mockDocx.mockImplementation(async () => new Blob(['docx']));
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ''; });

test('окно открывается: период, срез, стратегии, девять разделов, две кнопки', async () => {
  await mount();
  const dlg = document.body.querySelector('[role="dialog"]');
  expect(dlg).not.toBeNull();
  expect(dlg.textContent).toContain('Выгрузить отчёт');
  expect(dlg.querySelectorAll('.rx-check').length).toBe(9);
  expect([...dlg.querySelectorAll('.rx-seg button')].map((b) => b.textContent)).toEqual(['Реальные', 'Бумажные', 'Всё вместе']);
  expect(byText('Скачать PDF')).toBeTruthy();
  expect(byText('Скачать Word')).toBeTruthy();
  expect(dlg.textContent).toContain('Пробой');
});

test('по умолчанию включены главные разделы, «Список всех сделок» выключен', async () => {
  await mount();
  const boxes = [...document.body.querySelectorAll('.rx-check')];
  const on = (label) => boxes.find((b) => b.textContent.includes(label)).querySelector('input').checked;
  expect(on('Итоги периода')).toBe(true);
  expect(on('Динамика результата')).toBe(true);
  expect(on('Список всех сделок')).toBe(false);
});

test('свои даты: без дат кнопки выключены и видно пояснение; с датами — итог за период', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'custom');
  expect(document.body.textContent).toContain('Укажите обе даты');
  expect(byText('Скачать PDF').disabled).toBe(true);
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  const inputs = document.body.querySelectorAll('.rx-dates input[type="date"]');
  await change(inputs[0], d(NOW - 60 * 86400000));
  await change(document.body.querySelectorAll('.rx-dates input[type="date"]')[1], d(NOW));
  expect(document.body.querySelector('.rx-summary').textContent).toMatch(/3 сделки/);
  expect(byText('Скачать PDF').disabled).toBe(false);
});

test('конец периода раньше начала — понятная ошибка', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'custom');
  await change(document.body.querySelectorAll('.rx-dates input[type="date"]')[0], '2026-10-20');
  await change(document.body.querySelectorAll('.rx-dates input[type="date"]')[1], '2026-10-10');
  expect(document.body.textContent).toContain('Дата конца раньше даты начала');
});

test('«Скачать PDF» собирает модель выбранного периода и запускает скачивание', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  await click(byText('Скачать PDF'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(mockPdf).toHaveBeenCalledTimes(1);
  const model = mockPdf.mock.calls[0][0];
  expect(model.stats.total).toBe(3);
  expect(model.meta.scope).toBe('real');
  expect(model.sections).toContain('summary');
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload.mock.calls[0][1]).toMatch(/\.pdf$/);
  expect(mockDocx).not.toHaveBeenCalled();
});

test('«Скачать Word» собирает Word; снятые разделы не попадают в модель; выбор стратегии фильтрует сделки', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  const boxes = [...document.body.querySelectorAll('.rx-check')];
  await click(boxes.find((b) => b.textContent.includes('Динамика результата')).querySelector('input'));
  await click([...document.body.querySelectorAll('.rx-chip')].find((c) => c.textContent === 'Отскок'));
  await click(byText('Скачать Word'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(mockDocx).toHaveBeenCalledTimes(1);
  const model = mockDocx.mock.calls[0][0];
  expect(model.sections).not.toContain('curve');
  expect(model.stats.total).toBe(1);
  expect(model.meta.strategiesText).toBe('Отскок');
  expect(mockDownload.mock.calls[0][1]).toMatch(/\.docx$/);
});

test('если выбран период «как на странице», он совпадает с открытым в отчёте', async () => {
  await mount({ pageRange: { type: 'month', key: '2026-09', label: 'Сентябрь 2026' } });
  const sel = document.body.querySelector('select[aria-label="Период"]');
  expect(sel.textContent).toContain('Как на странице: Сентябрь 2026');
  await change(sel, 'page');
  expect(document.body.textContent).toContain('1–30 сентября 2026');
});

test('выбранные разделы запоминаются, Esc закрывает окно', async () => {
  await mount();
  const boxes = [...document.body.querySelectorAll('.rx-check')];
  await click(boxes.find((b) => b.textContent.includes('Список всех сделок')).querySelector('input'));
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  await click(byText('Скачать PDF'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(JSON.parse(localStorage.getItem('tp_report_export_v1')).sections).toContain('trades');
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(onClose).toHaveBeenCalled();
});

test('ошибка сборки показывается сообщением, кнопки снова доступны', async () => {
  const toast = require('react-hot-toast').default;
  mockPdf.mockImplementation(async () => { throw new Error('сломалось'); });
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  await click(byText('Скачать PDF'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(toast.error).toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
  expect(byText('Скачать PDF').disabled).toBe(false);
});

// ---------- вкладка «По расписанию» ----------
function SchedHarness({ initial = {}, saves }) {
  const [profile, setProfile] = React.useState(initial);
  const update = async (d) => { saves.push(d); setProfile((p) => ({ ...p, ...d })); };
  return (
    <ReportExportModal open onClose={() => {}} realTrades={trades} paperTrades={[]} strategyList={[{ name: 'Пробой', count: 2 }, { name: 'Отскок', count: 1 }]}
      defaultScope="real" defaultStrategies={[]} pageRange={null} profile={profile} canSchedule updateUserProfile={update} />
  );
}
async function mountSched(initial = {}) {
  const saves = [];
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<SchedHarness initial={initial} saves={saves} />); });
  await click(byText('По расписанию'));
  return saves;
}

test('без права на расписания вкладки «По расписанию» нет', async () => {
  await mount();
  expect(byText('По расписанию')).toBeUndefined();
});

test('вкладка расписаний: пустой список и пояснение про каналы доставки', async () => {
  await mountSched();
  expect(document.body.textContent).toContain('PDF-файлом');
  expect(document.body.textContent).toMatch(/в Telegram.*на почту или в MAX/);
  expect(document.body.textContent).toContain('Расписаний пока нет');
  expect(byText('Добавить расписание')).toBeTruthy();
});

test('новое расписание: по умолчанию — раз в месяц за прошлый месяц; сохраняется в профиль и появляется в списке', async () => {
  const saves = await mountSched();
  await click(byText('Добавить расписание'));
  await change(document.body.querySelector('input[placeholder^="Например"]'), 'Итоги месяца');
  await click(byText('Сохранить расписание'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(saves.length).toBe(1);
  const s = saves[0].reportSchedules[0];
  expect(s.frequency).toBe('monthly'); expect(s.period).toBe('last_month'); expect(s.hour).toBe(9); expect(s.name).toBe('Итоги месяца'); expect(s.enabled).toBe(true);
  expect(s.sections).toContain('summary'); expect(s.channels).toEqual(['telegram']); expect(s.email).toBe('');
  expect(document.body.textContent).toContain('Итоги месяца');
  expect(document.body.textContent).toContain('Каждый месяц, 1-го числа, в 9:00 · за прошлый месяц');
  expect(document.body.textContent).toContain('Следующая отправка');
});

const chBox = (label) => [...document.body.querySelectorAll('.rx-check')].find((b) => b.querySelector('b')?.textContent === label)?.querySelector('input');

test('куда присылать: по умолчанию только Telegram, и последний выбранный канал снять нельзя', async () => {
  await mountSched();
  await click(byText('Добавить расписание'));
  expect(chBox('Telegram').checked).toBe(true);
  expect(chBox('Telegram').disabled).toBe(true);
  expect(chBox('Почта').checked).toBe(false);
  expect(document.body.querySelector('input[type="email"]')).toBeNull();
});

test('почта: поле адреса появляется при выборе; без правильного адреса расписание не сохраняется; с адресом — сохраняется вместе с Telegram', async () => {
  const toast = require('react-hot-toast').default;
  const saves = await mountSched();
  await click(byText('Добавить расписание'));
  await click(chBox('Почта'));
  const email = document.body.querySelector('input[type="email"]');
  expect(email).toBeTruthy();
  await click(byText('Сохранить расписание'));
  expect(saves.length).toBe(0);
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('адрес почты'));
  await change(email, 'не адрес');
  await click(byText('Сохранить расписание'));
  expect(saves.length).toBe(0);
  await change(email, ' me@mail.ru ');
  await click(byText('Сохранить расписание'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const s = saves[0].reportSchedules[0];
  expect(s.channels).toEqual(['telegram', 'email']); expect(s.email).toBe('me@mail.ru');
  expect(document.body.textContent).toContain('Куда: Telegram, почта me@mail.ru');
});

test('новое расписание подставляет адрес почты из предыдущего', async () => {
  await mountSched({ reportSchedules: [{ id: 'rs_1', enabled: true, name: 'А', frequency: 'weekly', dayOfWeek: 0, hour: 9, period: 'last_week', scope: 'real', strategies: [], sections: ['summary'], channels: ['email'], email: 'old@mail.ru' }] });
  await click(byText('Добавить расписание'));
  await click(chBox('Почта'));
  expect(document.body.querySelector('input[type="email"]').value).toBe('old@mail.ru');
});

test('статус подключения каналов берётся из профиля, который заполняет робот: не подключено / подключено / ещё неизвестно', async () => {
  await mountSched({ reportDelivery: { telegram: true, email: false, max: true } });
  await click(byText('Добавить расписание'));
  await click(chBox('Почта'));
  await click(chBox('MAX'));
  const text = document.body.textContent;
  expect(text).toContain('В роботе пока нет ключей почты');
  expect(text).toContain('Подключено в роботе.');
  expect(text).toContain('только на компанию, ИП или самозанятого');
  act(() => root.unmount()); host.remove();
  await mountSched({});
  await click(byText('Добавить расписание'));
  await click(chBox('MAX'));
  expect(document.body.textContent).toContain('Статус подключения появится после ближайшего запуска робота');
});

test('еженедельное расписание: смена частоты подставляет «Прошлая неделя»; несоответствие периода и частоты — подсказка', async () => {
  const saves = await mountSched();
  await click(byText('Добавить расписание'));
  await click(byText('Каждую неделю'));
  expect(document.body.querySelector('select[aria-label="Период отчёта"]').value).toBe('last_week');
  await change(document.body.querySelector('select[aria-label="Период отчёта"]'), 'last_year');
  expect(document.body.textContent).toContain('будут одинаковыми');
  await change(document.body.querySelector('select[aria-label="Период отчёта"]'), 'last_week');
  await click(byText('Сохранить расписание'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(saves[0].reportSchedules[0].frequency).toBe('weekly');
  expect(document.body.textContent).toContain('Каждый понедельник');
});

test('разовая отправка без даты не сохраняется; прошедшая дата отклоняется', async () => {
  const saves = await mountSched();
  await click(byText('Добавить расписание'));
  await click(byText('Один раз'));
  await click(byText('Сохранить расписание'));
  expect(saves.length).toBe(0);
  await change(document.body.querySelector('.rx-dates input[type="date"]'), '2020-01-01');
  await click(byText('Сохранить расписание'));
  expect(saves.length).toBe(0);
});

test('включить/выключить, «Отправить сейчас» и удаление', async () => {
  const existing = { reportSchedules: [{ id: 'rs_1', enabled: true, name: 'Недельный', frequency: 'weekly', dayOfWeek: 4, hour: 18, period: 'last_week', scope: 'real', strategies: [], sections: ['summary'] }] };
  const saves = await mountSched(existing);
  expect(document.body.textContent).toContain('Каждую пятницу в 18:00 · за прошлую неделю');
  await click(document.body.querySelector('.rx-switch input'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(saves[0].reportSchedules[0].enabled).toBe(false);
  expect(document.body.textContent).toContain('Выключено');
  await click(document.body.querySelector('.rx-switch input'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  await click(byText('Отправить сейчас'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const last = saves[saves.length - 1].reportSchedules[0];
  expect(typeof last.sendNowAt).toBe('number');
  expect(document.body.textContent).toContain('Запрос «Отправить сейчас» принят');
  expect(require('react-hot-toast').default.success).toHaveBeenCalledWith(expect.stringContaining('Telegram'));
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  await click(byText('Удалить'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(saves[saves.length - 1].reportSchedules).toEqual([]);
});

test('статус последней отправки и ошибка показываются из журнала отправок', async () => {
  const existing = {
    reportSchedules: [{ id: 'rs_1', enabled: true, name: '', frequency: 'monthly', dayOfMonth: 1, hour: 9, period: 'last_month', scope: 'real', strategies: [], sections: ['summary'] }],
    reportSendLog: { rs_1: { lastSentOn: '2026-11-01', lastSentAt: Date.UTC(2026, 10, 1, 7, 5), lastTitle: 'Октябрь 2026', lastError: null } },
  };
  await mountSched(existing);
  expect(document.body.textContent).toMatch(/Последняя отправка: 1 ноября 2026 — «Октябрь 2026»/);
});
