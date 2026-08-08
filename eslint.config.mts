import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import prettierConfig from "eslint-config-prettier";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mts",
						"manifest.json",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["__tests__/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.jest,
			},
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"main.js",
		"scripts",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"jest.config.cjs",
		// Scorecard-scan reproduction tsconfig; not a source file to lint.
		"tsconfig.scan.json",
		// The config is inside the type-aware TS project, so 0.4.1 lints this file
		// against itself and flags the `...globals.*` / `...obsidianmd` spreads as
		// unsafe any assignments. Matches icon-palette and the standard template.
		"eslint.config.mts",
	]),
	// Last, so it wins: turns off the stylistic rules that would fight Prettier.
	prettierConfig,
);
