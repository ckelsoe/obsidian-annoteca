import { buildFindingsLane, laneSummary, lineOf } from '../hub-findings-model';
import type { PlumblineFinding } from '../plumbline-client';

const TEXT = ['First line here.', '', 'Third line with leverage in it.'].join(
	'\n',
);

const finding = (
	over: Partial<PlumblineFinding> & { starts?: number[] } = {},
): PlumblineFinding => {
	const { starts = [0], ...rest } = over;
	return {
		key: 'k',
		ruleSlug: 'r',
		packId: 'base',
		severity: 'warning',
		message: 'm',
		occurrences: starts.map((s) => ({
			start: s,
			end: s + 5,
			key: `o${s}`,
		})),
		confidence: 0.9,
		priority: 9,
		rolledUp: false,
		...rest,
	};
};

describe('lineOf', () => {
	it('is 1-based and counts newlines before the offset', () => {
		expect(lineOf(TEXT, 0)).toBe(1);
		expect(lineOf(TEXT, TEXT.indexOf('Third'))).toBe(3);
	});

	it('clamps an offset past the end', () => {
		expect(lineOf(TEXT, 10_000)).toBe(3);
	});
});

describe('buildFindingsLane', () => {
	// Plumbline computes priority (contract 3.3) and the lane honours it, so
	// both surfaces rank identically. Recomputing here would be a second
	// ranking the first time one is tuned.
	it('orders by the priority Plumbline sent', () => {
		const model = buildFindingsLane(
			[
				finding({ ruleSlug: 'low', priority: 1 }),
				finding({ ruleSlug: 'high', priority: 100 }),
				finding({ ruleSlug: 'mid', priority: 50 }),
			],
			TEXT,
		);
		expect(model.rows.map((r) => r.ruleSlug)).toEqual([
			'high',
			'mid',
			'low',
		]);
	});

	it('breaks a priority tie by rule, so the order is stable', () => {
		const model = buildFindingsLane(
			[
				finding({ ruleSlug: 'zebra', priority: 5 }),
				finding({ ruleSlug: 'alpha', priority: 5 }),
			],
			TEXT,
		);
		expect(model.rows.map((r) => r.ruleSlug)).toEqual(['alpha', 'zebra']);
	});

	// Errors and warnings get their own rows; suggestions collapse. Counted,
	// never dropped.
	it('puts suggestions below the floor and keeps them', () => {
		const model = buildFindingsLane(
			[
				finding({ ruleSlug: 'warn', severity: 'warning' }),
				finding({ ruleSlug: 'sugg', severity: 'suggestion' }),
				finding({ ruleSlug: 'err', severity: 'error' }),
			],
			TEXT,
		);
		expect(model.rows.map((r) => r.ruleSlug).sort()).toEqual([
			'err',
			'warn',
		]);
		expect(model.collapsed.map((r) => r.ruleSlug)).toEqual(['sugg']);
		expect(model.hidden).toBe(0);
	});

	it('locates a row by line and carries the flagged words', () => {
		const at = TEXT.indexOf('leverage');
		const model = buildFindingsLane([finding({ starts: [at] })], TEXT);
		expect(model.rows[0]?.line).toBe(3);
		expect(model.rows[0]?.text).toBe('lever');
		expect(model.rows[0]?.start).toBe(at);
	});

	// A rolled-up finding reports where it FIRST fired, not wherever the engine
	// happened to list first.
	it('reports the earliest occurrence of a rolled-up finding', () => {
		const model = buildFindingsLane(
			[finding({ starts: [30, 2, 18], rolledUp: true })],
			TEXT,
		);
		expect(model.rows[0]?.start).toBe(2);
		expect(model.rows[0]?.count).toBe(3);
		// The key is the first OCCURRENCE's, because promotion is per
		// occurrence (contract 7.2), not the finding's group key.
		expect(model.rows[0]?.key).toBe('o2');
	});

	it('caps the rows and reports how many it is hiding', () => {
		const many = Array.from({ length: 10 }, (_, i) =>
			finding({ ruleSlug: `r${i}`, priority: 100 - i }),
		);
		const model = buildFindingsLane(many, TEXT, 4);
		expect(model.rows).toHaveLength(4);
		expect(model.hidden).toBe(6);
	});

	it('counts a hidden suggestion in the same total', () => {
		const model = buildFindingsLane(
			[
				finding({ ruleSlug: 'a', severity: 'warning' }),
				finding({ ruleSlug: 'b', severity: 'suggestion' }),
			],
			TEXT,
			1,
		);
		expect(model.rows).toHaveLength(1);
		expect(model.collapsed).toHaveLength(0);
		expect(model.hidden).toBe(1);
	});

	it('has nothing to draw for no findings', () => {
		expect(buildFindingsLane([], TEXT)).toEqual({
			rows: [],
			collapsed: [],
			hidden: 0,
		});
	});
});

describe('laneSummary', () => {
	it('counts occurrences, worst severity first', () => {
		const model = buildFindingsLane(
			[
				finding({ ruleSlug: 'e', severity: 'error', starts: [0] }),
				finding({ ruleSlug: 'w', severity: 'warning', starts: [2, 8] }),
				finding({ ruleSlug: 's', severity: 'suggestion', starts: [4] }),
			],
			TEXT,
		);
		expect(laneSummary(model)).toBe('1 error, 2 warnings, 1 suggestion');
	});

	it('omits a severity that is not present', () => {
		const model = buildFindingsLane(
			[finding({ severity: 'warning' })],
			TEXT,
		);
		expect(laneSummary(model)).toBe('1 warning');
	});

	it('says so when there is nothing', () => {
		expect(laneSummary(buildFindingsLane([], TEXT))).toBe(
			'Nothing flagged.',
		);
	});
});
