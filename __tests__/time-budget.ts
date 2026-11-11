// A test's time limit. Stryker's instrumented code runs some 20 times slower,
// so a mutation run (stryker.config.mjs sets the flag) widens it. A runaway
// (quadratic or worse) walk still blows far past the wider limit.
export function timeBudget(ms: number): number {
	return process.env.ANNOTECA_MUTATION_RUN ? ms * 25 : ms;
}
