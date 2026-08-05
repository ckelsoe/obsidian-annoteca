import {
	buildSkillMarkdown,
	skillTargetPaths,
	parseSkillVersion,
	skillStatus,
	SKILL_SCHEMA_VERSION,
} from '../skill-export';
import { isAuthorToken, parseAll } from '../parser';
import type { CategoryDefinition } from '../types';

const CATEGORIES: CategoryDefinition[] = [
	{ id: 'tone', displayName: 'Tone' },
	{ id: 'source-needed', displayName: 'Source needed' },
];

describe('skillTargetPaths', () => {
	it('maps claude to the .claude skills path', () => {
		expect(skillTargetPaths('claude')).toEqual([
			'.claude/skills/annoteca/SKILL.md',
		]);
	});

	it('maps agent to the .agent skills path', () => {
		expect(skillTargetPaths('agent')).toEqual([
			'.agent/skills/annoteca/SKILL.md',
		]);
	});

	it('maps both to claude first, then agent', () => {
		expect(skillTargetPaths('both')).toEqual([
			'.claude/skills/annoteca/SKILL.md',
			'.agent/skills/annoteca/SKILL.md',
		]);
	});
});

describe('buildSkillMarkdown', () => {
	const skill = buildSkillMarkdown(CATEGORIES, undefined);

	it('starts with frontmatter naming the skill', () => {
		expect(skill.startsWith('---\nname: annoteca-comments\n')).toBe(true);
		expect(skill).toContain('description: ');
	});

	it('embeds every configured category with its display name', () => {
		expect(skill).toContain('| `tone` | Tone |');
		expect(skill).toContain('| `source-needed` | Source needed |');
	});

	it('contains the canonical marker regex', () => {
		expect(skill).toContain(
			'<!--\\s*annoteca/[a-z][a-z0-9-]*\\s*:[\\s\\S]*?-->',
		);
	});

	it('ships an example marker that the real parser accepts', () => {
		// The multi-line example in the skill must stay parseable; if the format
		// or the example drifts, assistants get taught a broken grammar.
		const comments = parseAll(skill);
		const example = comments.find((c) => c.category === 'tone');
		expect(example).toBeDefined();
		if (!example) return;
		expect(example.id).toBe('a3b9c2x7');
		expect(example.date).toBe('2026-05-23T09:12:00');
		expect(example.author).toBe('reviewer');
		expect(example.anchor?.text).toBe(
			'assumes a hiring freeze through December',
		);
		expect(example.replies).toHaveLength(2);
		expect(example.resolution?.author).toBe('reviewer');
	});

	it('teaches the address-by-replace flow and the annoteca-original fence', () => {
		expect(skill).toContain('[addressed');
		expect(skill).toContain('annoteca-original');
		expect(skill).toContain('Address a comment by replacing the passage');
	});

	it('forbids unprompted resolution and marker deletion, each with a rationale', () => {
		expect(skill).toContain('Never resolve a comment unprompted');
		expect(skill).toContain('Never delete a marker');
		// The rationales are present (parenthetical "rationale:" notes).
		expect(skill.match(/rationale:/g)?.length ?? 0).toBeGreaterThanOrEqual(
			2,
		);
	});

	it('ships an addressed example the real parser accepts (fence round-trips)', () => {
		const comments = parseAll(skill);
		const addressed = comments.find((c) => c.addressed !== undefined);
		expect(addressed).toBeDefined();
		if (!addressed) return;
		expect(addressed.addressed?.author).toBe('claude');
		expect(addressed.addressed?.original).toBe('It landed as a shock.');
		// The original anchor is kept as the historical record (F-272).
		expect(addressed.anchor?.text).toBe('it landed as a shock');
	});

	it('stamps the current skill schema version in the frontmatter', () => {
		expect(skill).toContain(
			`annoteca-skill-version: ${SKILL_SCHEMA_VERSION}`,
		);
		expect(parseSkillVersion(skill)).toBe(SKILL_SCHEMA_VERSION);
	});

	it('teaches the full timestamp and warns against date-only stamps (F-280)', () => {
		expect(skill).toContain('YYYY-MM-DDTHH:MM:SS');
		expect(skill).toContain(
			'Always stamp the current time, not a date alone',
		);
		// The example replies carry a time component, not just a date.
		expect(skill).toContain('[reply ai 2026-05-23T09:15:30]');
	});

	it('teaches the author token grammar the parser actually enforces', () => {
		expect(skill).toContain('[^\\s\\]<>]{1,32}');
		// Checked against the parser rather than against the prose, so the
		// worked repair the skill hands an assistant cannot drift from what
		// the grammar accepts.
		expect(isAuthorToken('Bob-Smith')).toBe(true);
		expect(isAuthorToken('Bob Smith')).toBe(false);
	});

	it('says what an author that breaks the grammar costs', () => {
		// The shape alone was already there through v4. What was missing is
		// that a bad author in a trailing line ends the structured walk, which
		// takes the id and the whole thread with it.
		expect(skill).toContain('makes the whole line unmatchable');
		expect(skill).toContain('Bob-Smith');
	});

	it('separates the two costs the way the parser actually applies them', () => {
		// Driven against the parser, because the skill makes a claim about a
		// difference between characters and a claim is where prose drifts.
		const marker = (author: string): string =>
			[
				'<!-- annoteca/note: the body',
				'[id=aaaa1111]',
				`[author=${author}]`,
				'-->',
			].join('\n');
		// A space drops the author line and keeps the identity.
		const spaced = parseAll(marker('Bob Smith'))[0];
		expect(spaced?.id).toBe('aaaa1111');
		expect(spaced?.author).toBeUndefined();
		// A `]` closes the bracket early, so the line is no structured shape at
		// all, the walk stops on it, and the id goes into the body with it.
		const bracketed = parseAll(marker('Bob]Smith'))[0];
		expect(bracketed?.id).toBeUndefined();
		expect(bracketed?.body).toContain('[id=aaaa1111]');
		// Which is what the skill now tells an assistant.
		expect(skill).toContain('A `]` is worse');
	});

	it("names the reviewer's author tag when one is configured", () => {
		const withTag = buildSkillMarkdown(CATEGORIES, 'Charles');
		expect(withTag).toContain('signs comments as `Charles`');
	});

	it('uses the configured tag verbatim rather than repairing it', () => {
		// normalizeSettings is the single ingress and has already run the tag
		// through the grammar, so this cannot arrive padded. The assertion
		// exists to keep a second copy of that repair from growing back here.
		expect(buildSkillMarkdown(CATEGORIES, ' Charles ')).toContain(
			'signs comments as ` Charles `',
		);
	});

	it('suggests a generic tag when no author tag is configured', () => {
		expect(skill).toContain('such as `claude` or `ai`');
	});
});

describe('skill staleness detection (F-277)', () => {
	const current = buildSkillMarkdown(CATEGORIES, undefined);

	it('parseSkillVersion reads the stamp, and returns 0 when absent', () => {
		expect(parseSkillVersion(current)).toBe(SKILL_SCHEMA_VERSION);
		expect(parseSkillVersion('# a skill with no version stamp')).toBe(0);
	});

	it('skillStatus reports missing / stale / current', () => {
		expect(skillStatus(null)).toBe('missing');
		expect(skillStatus('an old skill, no stamp')).toBe('stale');
		expect(skillStatus('---\nannoteca-skill-version: 1\n---')).toBe(
			SKILL_SCHEMA_VERSION > 1 ? 'stale' : 'current',
		);
		expect(skillStatus(current)).toBe('current');
	});

	it('flags a v4 export as stale, because it predates the author grammar', () => {
		// The prompt to re-export is the only thing that reaches an assistant
		// already working from the old file, so teaching new grammar without
		// the bump teaches nobody.
		expect(skillStatus('---\nannoteca-skill-version: 4\n---')).toBe(
			'stale',
		);
	});
});
