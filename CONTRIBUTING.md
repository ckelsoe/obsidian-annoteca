# Contributing to Annoteca

Thanks for your interest in improving Annoteca. This guide explains how to get a local build running, propose changes, and submit pull requests.

## Reporting issues

- Search [existing issues](https://github.com/ckelsoe/obsidian-annoteca/issues) before opening a new one.
- For bugs, include Obsidian version, platform (Windows/macOS/Linux/iOS/Android), plugin version, and reproduction steps.
- For feature requests, describe the use case and how it fits the plugin's scope.

## Development setup

1. Fork and clone the repo.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the dev build with file watching:
   ```bash
   npm run dev
   ```
4. Copy `main.js`, `manifest.json`, and `styles.css` into a test vault under `.obsidian/plugins/annoteca/`, then enable the plugin in Obsidian.

## Quality gates

Before opening a pull request, run:

```bash
npm run lint       # ESLint with eslint-plugin-obsidianmd recommended, zero warnings allowed
npm run build      # TypeScript strict type-check + esbuild production bundle
npm test           # Jest unit tests
```

All three must pass. Pull requests that break CI will not be reviewed until green.

## Coding conventions

- TypeScript strict mode is on. Never use `as any` casting. If types are missing, add declarations to `types.d.ts`.
- Follow [Obsidian's plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Prefer `containerEl.createDiv()` / `createSpan()` over generic `createEl('div'|'span')`.
- Do not import Node built-ins (`path`, `fs`, etc.) at the top of `main.ts`. Use a `Platform.isDesktop`-guarded `require()` instead.
- No inline `style` attributes. Move styles to `styles.css`.
- Settings tab headings must avoid the words "settings", "options", "general", and the plugin name.
- All UI strings (commands, menu titles, setting names, notifications) use sentence case. Brands recognized by `eslint-plugin-obsidianmd` (Markdown, macOS, iOS, Windows, Linux, etc.) keep their official casing.
- Keep the settings UI compatible with mobile (`isDesktopOnly: false` means features must degrade gracefully on iOS/Android).

## Submitting a pull request

1. Create a feature branch off `main`.
2. Make focused, atomic commits.
3. Update `CHANGELOG.md` under an `## [Unreleased]` heading describing user-visible changes.
4. Push your branch and open a PR against `main`.
5. Fill out the PR description: what changed, why, and how to test it.

## Releases

Releases are cut by the maintainer. The release workflow runs automatically on tag push and:

1. Builds and tests the plugin.
2. Generates SLSA build provenance attestation for `main.js`, `manifest.json`, and `styles.css`.
3. Submits artifacts to VirusTotal for malware analysis (requires `VT_API_KEY` repo secret).
4. Extracts the matching `CHANGELOG.md` section as release notes.
5. Publishes the GitHub release.

Contributors do not need to bump versions or create release artifacts.

## License

By contributing you agree that your contributions are licensed under the MIT License (see `LICENSE`).
