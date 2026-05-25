import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
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
						"types.d.ts",
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
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"jest.config.cjs",
	]),
);
