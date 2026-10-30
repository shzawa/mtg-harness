import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'Meet Tab Guard',
    description: 'Google Meet の /meet/ で始まるページを閉じる前に確認を表示します。',
  },
});
