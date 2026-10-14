// relay/yandex.js - точка входа для Yandex Cloud Functions: рантайм Яндекса по записи
// `relay/yandex.handler` ищет именно файл yandex.js (расширение .mjs он не подставляет).
// Сама обёртка живёт в yandex.mjs; package.json архива с "type": "module" делает этот файл ESM.
export { handler } from './yandex.mjs';
