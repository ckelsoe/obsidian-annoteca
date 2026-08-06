/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/__tests__/**/*.test.ts'],
	// TypeScript FIRST. Jest's default order puts `js` ahead of `ts`, and this
	// repo's build writes `main.js` next to `main.ts`, so a test importing
	// `../main` for a value resolved to the last BUILD instead of the source.
	// Nothing failed loudly: the suite just silently exercised whatever was
	// built last, which passes until the source and the bundle disagree.
	moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: {
				// Override ESNext module to CommonJS for Jest compatibility
				module: 'CommonJS',
			},
		}],
	},
};
