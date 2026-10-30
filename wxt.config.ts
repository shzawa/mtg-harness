import { defineConfig } from 'wxt';
import { licensePlugin } from './scripts/licenses.ts';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'MTG Harness',
    description: 'Google Meet の /meet/ で始まるページを閉じる前に確認を表示します。',
  },
  vite: () => ({
    plugins: [licensePlugin()],
    build: {
      license: { fileName: 'THIRD_PARTY_LICENSES.json' },
    },
  }),
});
