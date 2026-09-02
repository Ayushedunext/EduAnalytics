import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      // tools/ is not product code and most of it needs no tests. The staging
      // sign-in gate (tools/erp-stub) is the exception: it is what stands
      // between the internet and a database of real school data, and its
      // fail-closed behaviour is invisible when it breaks.
      'tools/**/test/**/*.test.ts',
    ],
    environment: 'node',
  },
});
