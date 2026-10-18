// A JSON syntax check that can be paused and resumed, for asking "can this
// text continue that JSON?" of many candidate continuations without parsing
// the shared start again for each. It answers only whether JSON.parse would
// accept the whole text, never what it means; a caller that needs the value
// parses once a candidate passes.
//
// The nested-comment repair uses it to find where the left-behind half of a
// split store entry starts: of many places it could, nearly all are prose,
// which this rejects within a few characters, where building and parsing the
// whole candidate each time was quadratic.
//
// No dependencies.

type Frame = 'object' | 'array';

// Where the scan is: what may come next, and the containers it is inside.
interface JsonState {
	// value: a value may start. key: a key or `}` may start (just after `{`);
	// nextKey: a key must start (after `,` in an object). colon, comma (a `,`
	// or the container's close), done (only whitespace may follow).
	expect:
		'value' | 'firstValue' | 'key' | 'nextKey' | 'colon' | 'comma' | 'done';
	stack: Frame[];
	// Inside a string: whether it is a key, and the escape progress (0 none,
	// 1 after a backslash, 2 to 5 counting \u hex digits).
	string: { key: boolean; escape: number } | undefined;
	// Inside a literal: the characters read so far (at most five).
	token: string | undefined;
	// Inside a number: where in its grammar the scan is. A state rather than
	// the characters, so a long number costs one step a digit.
	number: NumberState | undefined;
}

// -  0  1-9  .  digit  e  +/-  digit, as JSON numbers run.
type NumberState =
	'minus' | 'zero' | 'int' | 'dot' | 'frac' | 'e' | 'esign' | 'exp';
const NUMBER_ENDS: readonly NumberState[] = ['zero', 'int', 'frac', 'exp'];

function numberStep(state: NumberState, ch: string): NumberState | undefined {
	const digit = ch >= '0' && ch <= '9' && ch.length === 1;
	switch (state) {
		case 'minus':
			return ch === '0' ? 'zero' : digit ? 'int' : undefined;
		case 'zero':
			return ch === '.'
				? 'dot'
				: ch === 'e' || ch === 'E'
					? 'e'
					: undefined;
		case 'int':
			return digit
				? 'int'
				: ch === '.'
					? 'dot'
					: ch === 'e' || ch === 'E'
						? 'e'
						: undefined;
		case 'dot':
			return digit ? 'frac' : undefined;
		case 'frac':
			return digit ? 'frac' : ch === 'e' || ch === 'E' ? 'e' : undefined;
		case 'e':
			return ch === '+' || ch === '-'
				? 'esign'
				: digit
					? 'exp'
					: undefined;
		case 'esign':
		case 'exp':
			return digit ? 'exp' : undefined;
	}
}

export function jsonStart(): JsonState {
	return {
		expect: 'value',
		stack: [],
		string: undefined,
		token: undefined,
		number: undefined,
	};
}

function copy(s: JsonState): JsonState {
	return {
		expect: s.expect,
		stack: [...s.stack],
		string: s.string ? { ...s.string } : undefined,
		token: s.token,
		number: s.number,
	};
}

const LITERALS = ['true', 'false', 'null'];

// After a value ends: what may follow it.
function afterValue(s: JsonState): void {
	s.expect = s.stack.length === 0 ? 'done' : 'comma';
}

// Finish a number or literal being read, or report that it cannot end here.
function endToken(s: JsonState): boolean {
	if (s.number !== undefined) {
		const ends = NUMBER_ENDS.includes(s.number);
		s.number = undefined;
		if (ends) afterValue(s);
		return ends;
	}
	const t = s.token;
	if (t === undefined) return true;
	s.token = undefined;
	if (LITERALS.includes(t)) {
		afterValue(s);
		return true;
	}
	return false;
}

// Feed text[from, to) to the scan. Returns false at the first character
// JSON.parse would reject; the state is then meaningless.
export function jsonFeed(
	state: JsonState,
	text: string,
	from: number,
	to: number,
): boolean {
	const s = state;
	for (let i = from; i < to; i++) {
		const ch = text.charAt(i);
		if (s.string) {
			const str = s.string;
			if (str.escape === 1) {
				if (ch === 'u') str.escape = 2;
				else if ('"\\/bfnrt'.includes(ch)) str.escape = 0;
				else return false;
			} else if (str.escape >= 2) {
				if (!/[0-9a-fA-F]/.test(ch)) return false;
				str.escape = str.escape === 5 ? 0 : str.escape + 1;
			} else if (ch === '\\') str.escape = 1;
			else if (ch === '"') {
				s.string = undefined;
				if (str.key) s.expect = 'colon';
				else afterValue(s);
			} else if (ch < ' ') return false;
			continue;
		}
		if (s.number !== undefined) {
			const step = numberStep(s.number, ch);
			if (step !== undefined) {
				s.number = step;
				continue;
			}
			if (!endToken(s)) return false;
		} else if (s.token !== undefined) {
			const next = s.token + ch;
			if (LITERALS.some((l) => l.startsWith(next))) {
				s.token = next;
				continue;
			}
			if (!endToken(s)) return false;
		}
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
		switch (s.expect) {
			case 'value':
			case 'firstValue':
				if (ch === '{') {
					s.stack.push('object');
					s.expect = 'key';
				} else if (ch === '[') {
					s.stack.push('array');
					s.expect = 'firstValue';
				} else if (ch === '"') s.string = { key: false, escape: 0 };
				else if (ch === ']' && s.expect === 'firstValue') {
					s.stack.pop();
					afterValue(s);
				} else if (ch === '-') s.number = 'minus';
				else if (ch === '0') s.number = 'zero';
				else if (ch >= '1' && ch <= '9') s.number = 'int';
				else if (ch === 't' || ch === 'f' || ch === 'n') s.token = ch;
				else return false;
				break;
			case 'key':
			case 'nextKey':
				if (ch === '"') s.string = { key: true, escape: 0 };
				else if (ch === '}' && s.expect === 'key') {
					s.stack.pop();
					afterValue(s);
				} else return false;
				break;
			case 'colon':
				if (ch !== ':') return false;
				s.expect = 'value';
				break;
			case 'comma': {
				const top = s.stack[s.stack.length - 1];
				if (ch === ',')
					s.expect = top === 'object' ? 'nextKey' : 'value';
				else if (ch === '}' && top === 'object') {
					s.stack.pop();
					afterValue(s);
				} else if (ch === ']' && top === 'array') {
					s.stack.pop();
					afterValue(s);
				} else return false;
				break;
			}
			case 'done':
				return false;
		}
	}
	return true;
}

// Whether the text fed so far is a whole JSON value, as JSON.parse needs.
export function jsonComplete(state: JsonState): boolean {
	const s = copy(state);
	if (s.string) return false;
	if (!endToken(s)) return false;
	return s.expect === 'done';
}

// Whether the scan is between tokens, where whitespace changes nothing: two
// continuations that differ only in leading whitespace then read the same.
export function jsonBetweenTokens(state: JsonState): boolean {
	return (
		state.string === undefined &&
		state.token === undefined &&
		state.number === undefined
	);
}

// A copy to resume from, so one shared start serves many continuations.
export function jsonFork(state: JsonState): JsonState {
	return copy(state);
}
