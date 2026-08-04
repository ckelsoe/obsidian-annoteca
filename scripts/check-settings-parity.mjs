// Settings render through two independent paths and BOTH are live:
// getSettingDefinitions() for Obsidian 1.13+, and renderImperativeSettings()
// for everything down to minAppVersion 1.8.7. A row added to only one is
// invisible to half the supported range.
//
// Nothing enforced that until now; every setting was kept in sync by hand, and
// the running test vault is 1.13.x, so a manual check only ever exercises the
// declarative path. This is the guard.
//
// It lives here rather than in a Jest test for two reasons. The imperative path
// builds real Obsidian `Setting` widgets, so exercising it would need a
// hand-written stand-in for Obsidian's settings UI, and a fake Obsidian between
// the test and the code is a thing that can itself be wrong. And the check has
// to read source text, which `obsidianmd/no-nodejs-modules` rightly forbids in
// plugin code; `scripts/` is outside the lint scope and already the home for
// checks the eslint plugin cannot express.
//
// The real fix is for the imperative path to iterate getSettingDefinitions()
// instead of restating it, which would make parity structural and this script
// unnecessary. That is a refactor of its own, not a rider on a feature change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(here, '..', 'settings.ts');
const source = readFileSync(settingsPath, 'utf8');

const problems = [];

function region(startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1 || end <= start) {
		problems.push(
			`Could not locate the region between "${startMarker}" and "${endMarker}" in settings.ts. ` +
				`If those methods were renamed, update this script.`,
		);
		return '';
	}
	return source.slice(start, end);
}

// Keys of the DEFAULT_SETTINGS object literal, read at one indent level so
// nested object keys (scopeState's shape, for instance) are not picked up.
function settingKeys() {
	const start = source.indexOf('DEFAULT_SETTINGS: AnnotecaSettings = {');
	const end = source.indexOf('\n};', start);
	if (start === -1 || end === -1) {
		problems.push('Could not locate DEFAULT_SETTINGS in settings.ts.');
		return [];
	}
	return [...source.slice(start, end).matchAll(/^\t([A-Za-z0-9_]+):/gm)].map(
		(m) => m[1],
	);
}

// Settings with bespoke UI (categories, presets, authors) or that are persisted
// state with no row at all. Listed so that adding a key with no row is a
// decision someone made here, not drift nobody noticed.
// A Map rather than a Set so each exemption carries its justification. The
// check below only reads the keys; the reasons exist so that adding a key here
// is a decision a reviewer can weigh, not a way to opt out of parity silently.
const NO_PLAIN_ROW = new Map([
	['authorStyles', 'Bespoke UI: per-collaborator color rows.'],
	['categories', 'Bespoke UI: the category editor with reorder and icons.'],
	['customPresets', 'Bespoke UI: rendered by the preset browser.'],
	[
		'enableScholarlyPreset',
		'Applied through the preset browser, not a standalone toggle.',
	],
	['lastHubTab', 'Persisted UI state, not a user-facing preference.'],
	['scopeState', 'Persisted UI state: the hub scope and whether it is pinned.'],
	[
		'settingsBackupPath',
		'Written by the import backup flow; surfaced in its confirmation, not as a row.',
	],
	['starredComments', 'Persisted data: the starred set, edited from the hub.'],
	['statusFilter', 'Persisted UI state: the hub open/resolved filter.'],
]);

const declarative = region('getSettingDefinitions()', 'display(): void');
const imperative = region(
	'private renderImperativeSettings(): void',
	'private heading(container',
);

const keys = settingKeys();
const namedIn = (text) => keys.filter((k) => text.includes(`'${k}'`));

if (problems.length === 0) {
	const inDeclarative = namedIn(declarative);
	const inImperative = namedIn(imperative);

	for (const key of inDeclarative) {
		if (!inImperative.includes(key)) {
			problems.push(
				`"${key}" has a row in getSettingDefinitions() but not in renderImperativeSettings(). ` +
					`It would be invisible below Obsidian 1.13.`,
			);
		}
	}
	for (const key of inImperative) {
		if (!inDeclarative.includes(key)) {
			problems.push(
				`"${key}" has a row in renderImperativeSettings() but not in getSettingDefinitions(). ` +
					`It would be invisible on Obsidian 1.13 and later.`,
			);
		}
	}

	const rendered = new Set([...inDeclarative, ...inImperative]);
	for (const key of keys) {
		if (!rendered.has(key) && !NO_PLAIN_ROW.has(key)) {
			problems.push(
				`"${key}" is in DEFAULT_SETTINGS but has no settings row in either path. ` +
					`Add a row, or add it to NO_PLAIN_ROW in this script with a reason.`,
			);
		}
	}

	// A guard that silently matches nothing is worse than no guard.
	if (keys.length < 20 || inDeclarative.length < 20) {
		problems.push(
			`Only found ${keys.length} settings keys and ${inDeclarative.length} declarative rows, ` +
				`which suggests the parsing above stopped working rather than that the file shrank.`,
		);
	}
}

if (problems.length > 0) {
	console.error('Settings parity check failed:\n');
	for (const p of problems) console.error(`  - ${p}`);
	console.error('');
	process.exit(1);
}

console.log('Settings parity check passed');
