// Снимки календаря и окна подтверждения для просмотра глазами:
// QA_PREVIEW=1 CI=true npx react-scripts test --watchAll=false src/qa/dialogs
// Результат — scripts/_preview/dialog-*.html. Без QA_PREVIEW тест пропускается.
import React from 'react';
import fs from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

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
run('календарь и окно подтверждения', () => {
  const DatePicker = require('../components/shared/DatePicker').default;
  const { ConfirmView } = require('../components/shared/confirmDialog');
  const css = allCss();
  for (const theme of ['light', 'dark']) {
    test(`dialogs (${theme})`, async () => {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.innerHTML = '';
      fs.mkdirSync(OUT, { recursive: true });
      const snap = (name) => fs.writeFileSync(path.join(OUT, `dialog-${name}-${theme}.html`),
        `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>${css}</style></head><body style="min-height:520px;background:var(--bg-primary)">${document.body.innerHTML}</body></html>`, 'utf8');
      const host = document.createElement('div'); host.style.cssText = 'padding:40px'; document.body.appendChild(host);
      const root = createRoot(host);
      // календарь рисуется в портале с fixed-позицией; в jsdom размеров нет — зададим их, чтобы снимок был похож на настоящий
      Element.prototype.getBoundingClientRect = function rect() { return { left: 40, right: 200, top: 40, bottom: 80, width: 160, height: 40, x: 40, y: 40 }; };
      await act(async () => { root.render(<label>С <DatePicker value="2026-11-06" onChange={() => {}} /></label>); });
      await act(async () => { host.querySelector('.dp-btn').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      snap('calendar');
      await act(async () => { root.render(<ConfirmView title="Удалить расписание?" text="«Итоги недели» больше не будет присылать отчёты. Уже отправленные отчёты это не затрагивает." confirmLabel="Удалить" cancelLabel="Отмена" danger onResult={() => {}} />); });
      snap('confirm');
      act(() => root.unmount());
    }, 30000);
  }
});
