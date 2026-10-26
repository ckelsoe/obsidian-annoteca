// What "Repair comments written inside other comments" tells the user before
// and while it runs. The repair is quick on most notes, but where many
// comments were written into one stretch of a note it grows with the square
// of their number and can take seconds, with Obsidian busy meanwhile. So the
// notes are found first, with the quick check the damage notice uses, the
// heavily damaged ones are named, and a run shows which note it is on.
// Pure, so the wording and the choice of notes are testable without Obsidian.

import { damagedPieceCount, SLOW_REPAIR_PIECES } from './nested-repair';
import { hasRepairableDamage } from './quote-repair';

export interface RepairTarget {
	path: string;
	name: string;
	// Many damaged comments: the repair may take seconds.
	slow: boolean;
}

// The note as a target, or undefined when the repair would not change it.
export function repairTarget(
	path: string,
	name: string,
	text: string,
): RepairTarget | undefined {
	if (!hasRepairableDamage(text)) return undefined;
	return { path, name, slow: damagedPieceCount(text) >= SLOW_REPAIR_PIECES };
}

// Past this many, the list ends with a count of the rest.
const LISTED = 20;

const SLOW_NOTE = 'many damaged comments, may take a few seconds';

// The confirmation's description and its list of notes.
export function repairConfirmText(targets: readonly RepairTarget[]): {
	description: string;
	items: string[];
} {
	const n = targets.length;
	const items = targets
		.slice(0, LISTED)
		.map((t) => (t.slow ? `${t.name}: ${SLOW_NOTE}` : t.name));
	if (n > LISTED) items.push(`and ${n - LISTED} more`);
	return {
		description: `Move every comment that was written inside another comment, a range end, the comment store or the note properties to just outside it. The comment that held it gets its text back. An HTML comment copied into a comment's original text is escaped, so the comment reads whole again. A note is changed only when the repair leaves it whole with every comment kept. ${n === 1 ? '1 note needs it' : `${n} notes need it`}:`,
		items,
	};
}

export const REPAIR_SCOPE_TEXT =
	'Only these notes are changed, and the plugin cannot undo it. Use Git, Obsidian Sync, or an external backup to make sure you can roll back.';

export function repairProgressText(
	done: number,
	total: number,
	target: RepairTarget,
): string {
	const slow = target.slow
		? ' It has many damaged comments, so this may take a few seconds.'
		: '';
	return `Repairing comments: note ${done} of ${total}, ${target.name}.${slow}`;
}

export function repairSlowNoteText(name: string): string {
	return `Repairing ${name}. It has many damaged comments, so this may take a few seconds.`;
}
