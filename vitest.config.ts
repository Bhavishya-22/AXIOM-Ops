import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@axiomops/shared': path.resolve(__dirname, './shared/src/index.ts'),
    },
  },
});
