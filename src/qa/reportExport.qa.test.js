// Снимки окна «Выгрузить отчёт» (вкладки «Скачать сейчас» и «По расписанию») для просмотра глазами:
// QA_PREVIEW=1 CI=true npx react-scripts test --watchAll=false src/qa/reportExport
// Результат — scripts/_preview/export-*.html. Без QA_PREVIEW тест пропускается.
import React from 'react';
import fs from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

jest.mock('react-hot-toast', () => { const t = jest.fn(); t.success = jest.fn(); t.error = jest.fn(); return { __esModule: true, default: t }; });
jest.mock('../services/report/exportClient', () => ({ buildPdfBlob: jest.fn(), buildDocxBlob: jest.fn(), downloadBlob: jest.fn(), reportFileName: () => 'x.pdf' }));

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'scripts/_preview');
function allCss() {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.css')) files.push(p);
  });
  walk(path.join(ROOT, 'src'));
  files.sort((a, b) => (a.includes('globals.css') ? -1 : b.includes('globals.css') ? 1 : a.localeCompare(b)));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

const run = process.env.QA_PREVIEW ? describe : describe.skip;
run('окно выгрузки отчёта', () => {
  const ReportExportModal = require('../components/report/ReportExportModal').default;
  const css = allCss();
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const trades = [
    { status: 'closed', pnl: 1500, closedAt: iso(40), ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой' },
    { status: 'closed', pnl: -600, closedAt: iso(38), ticker: 'GAZP', direction: 'short', entryStrategyName: 'Отскок' },
    { status: 'closed', pnl: 900, closedAt: iso(5), ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой' },
  ];
  const profile = {
    reportSchedules: [
      { id: 'a', enabled: true, name: 'Итоги недели', frequency: 'weekly', dayOfWeek: 0, hour: 9, period: 'last_week', scope: 'real', strategies: [], sections: ['summary', 'curve', 'habits'] },
      { id: 'b', enabled: true, name: '', frequency: 'monthly', dayOfMonth: 1, hour: 10, period: 'last_month', scope: 'all', strategies: ['Пробой'], sections: ['summary', 'curve', 'instruments', 'strategies', 'habits'] },
      { id: 'c', enabled: false, name: 'Годовой', frequency: 'once', date: '2026-12-31', hour: 12, period: 'this_year', scope: 'real', strategies: [], sections: ['summary'] },
    ],
    reportSendLog: { a: { lastSentOn: '2026-11-03', lastSentAt: Date.now() - 2 * 86400000, lastTitle: 'Неделя 26 октября – 1 ноября 2026', lastError: null }, b: { lastError: 'Bad Request: chat not found', lastErrorDay: '2026-11-04', tries: 2 } },
  };
  const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
  const byText = (t) => [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim().includes(t));

  for (const theme of ['light', 'dark']) {
    test(`export modal (${theme})`, async () => {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.innerHTML = '';
      const host = document.createElement('div'); document.body.appendChild(host);
      const root = createRoot(host);
      const snap = (name) => fs.writeFileSync(path.join(OUT, `export-${name}-${theme}.html`),
        `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>${css}</style></head><body>${document.body.innerHTML}</body></html>`, 'utf8');
      fs.mkdirSync(OUT, { recursive: true });
      await act(async () => {
        root.render(<ReportExportModal open onClose={() => {}} realTrades={trades} paperTrades={[]} strategyList={[{ name: 'Пробой', count: 2 }, { name: 'Отскок', count: 1 }]}
          defaultScope="real" defaultStrategies={[]} pageRange={null} profile={profile} canSchedule updateUserProfile={async () => {}} />);
      });
      snap('now');
      await click(byText('По расписанию'));
      snap('schedules');
      await click(byText('Добавить расписание'));
      snap('editor');
      act(() => root.unmount());
    }, 30000);
  }
});
