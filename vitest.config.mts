import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// TypeScript first. The build writes main.js next to main.ts, and with the
		// default order a test importing `../main` would run the last build, not the
		// source.
		extensions: ['.ts', '.mts', '.mjs', '.js', '.json'],
		// Tests run against the stub, never the real (types-only) package.
		alias: {
			obsidian: fileURLToPath(
				new URL('./__mocks__/obsidian.ts', import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['__tests__/**/*.test.ts'],
		// The fuzz suites take about 6s on a fast machine; Jest never enforced its 5s
		// limit on a synchronous test, Vitest does. Stryker's instrumented code runs
		// some 20 times slower, so a mutation run (stryker.config.mjs sets the flag)
		// gets far more.
		testTimeout: process.env.ANNOTECA_MUTATION_RUN ? 600_000 : 30_000,
	},
});
