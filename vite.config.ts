import { defineConfig } from 'vitest/config';
import { patheryDaily } from './tools/pathery-site.ts';

export default defineConfig({
  plugins: [patheryDaily()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
