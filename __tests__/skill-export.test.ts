import {
	buildSkillMarkdown,
	skillTargetPaths,
	parseSkillVersion,
	skillStatus,
	SKILL_SCHEMA_VERSION,
} from '../skill-export';
import { parseAll } from '../parser';
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

	it("names the reviewer's author tag when one is configured", () => {
		const withTag = buildSkillMarkdown(CATEGORIES, 'Charles');
		expect(withTag).toContain('signs comments as `Charles`');
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
});
