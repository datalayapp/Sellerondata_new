/**
 * `npm test`. Kabuk React'i kendisi kurmaz (uygulamada iki kopya olur): bileşen testleri React, react-dom,
 * react-router ve react-query'yi Merkez'in (`apps/hub-web`) node_modules'ından alır. Önce orada `npm install` gerekir.
 * Oturum istemcisi testi Node ortamında, bileşen testleri (`*.test.tsx`) happy-dom'da koşar.
 */
const at = (path: string) => new URL(path, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const HUB = '../../apps/hub-web/node_modules/';

export default {
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: true,
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
  },
  resolve: {
    alias: [
      { find: '@sellerondata/contracts', replacement: at('../contracts/src/index.ts') },
      { find: '@sellerondata/format', replacement: at('../format/src/index.ts') },
      { find: /^i18next$/, replacement: at('./test/i18next.stub.ts') },
      { find: /^react-i18next$/, replacement: at('./test/react-i18next.stub.ts') },
      { find: /^react-dom(\/.*)?$/, replacement: at(`${HUB}react-dom`) + '$1' },
      { find: /^react(\/.*)?$/, replacement: at(`${HUB}react`) + '$1' },
      { find: /^@tanstack\/react-query$/, replacement: at(`${HUB}@tanstack/react-query`) },
      { find: /^react-router$/, replacement: at(`${HUB}react-router`) },
    ],
  },
};
