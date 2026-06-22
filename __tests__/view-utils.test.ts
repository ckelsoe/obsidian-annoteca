import { formatStamp } from "../view-utils";

describe("view-utils: formatStamp", () => {
	it("renders a full timestamp as date and time, keeping seconds", () => {
		expect(formatStamp("2026-06-22T14:30:12")).toBe("2026-06-22 14:30:12");
	});

	it("renders a timestamp with no seconds as date plus HH:MM", () => {
		expect(formatStamp("2026-06-22T14:30")).toBe("2026-06-22 14:30");
	});

	it("passes a legacy date-only stamp through unchanged", () => {
		expect(formatStamp("2026-06-22")).toBe("2026-06-22");
	});
});
