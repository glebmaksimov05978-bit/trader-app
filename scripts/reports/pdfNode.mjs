// scripts/reports/pdfNode.mjs
//
// Сборка PDF на сервере/в скриптах: описание документа (src/services/report/pdfDoc.js) → буфер PDF через pdfmake.
// Шрифт Roboto берётся из самого пакета pdfmake (в нём есть кириллица). Используется и фоновой отправкой по расписанию,
// и проверками/примерами. В браузере то же описание собирается в src/services/report/exportClient.js.
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

let configured = null;
function pdfmake() {
  if (configured) return configured;
  const pm = require('pdfmake');
  const dir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
  // Отчёт не должен ходить в сеть и читать чужие файлы: разрешены только шрифты из самого пакета.
  pm.setUrlAccessPolicy(() => false);
  pm.setLocalAccessPolicy((p) => path.resolve(p).startsWith(dir));
  pm.setFonts({
    Roboto: {
      normal: path.join(dir, 'Roboto-Regular.ttf'),
      bold: path.join(dir, 'Roboto-Medium.ttf'),
      italics: path.join(dir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(dir, 'Roboto-MediumItalic.ttf'),
    },
  });
  configured = pm;
  return pm;
}

/** @returns {Promise<Buffer>} готовый PDF */
export async function renderPdfBuffer(docDefinition) {
  const pdf = pdfmake().createPdf(docDefinition);
  return pdf.getBuffer();
}
