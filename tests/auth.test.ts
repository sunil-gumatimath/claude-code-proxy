import { describe, expect, test } from "bun:test";
import { extractApiKey, isAuthorized } from "../src/auth";

function req(headers?: Record<string, string>): Request {
	return new Request("http://127.0.0.1:4181/v1/messages", { headers });
}

describe("extractApiKey", () => {
	test("prefers x-api-key", () => {
		expect(extractApiKey(req({ "x-api-key": "k1", authorization: "Bearer k2" }))).toBe(
			"k1",
		);
	});

	test("reads a Bearer authorization header", () => {
		expect(extractApiKey(req({ authorization: "Bearer k2" }))).toBe("k2");
	});

	test("accepts a raw token with no Bearer prefix", () => {
		expect(extractApiKey(req({ authorization: "k3" }))).toBe("k3");
	});

	test("trims surrounding whitespace", () => {
		expect(extractApiKey(req({ "x-api-key": "  k4  " }))).toBe("k4");
	});

	test("ignores a blank x-api-key and falls through", () => {
		expect(extractApiKey(req({ "x-api-key": "   ", authorization: "Bearer k5" }))).toBe(
			"k5",
		);
	});

	test("returns empty when no credential is present", () => {
		expect(extractApiKey(req())).toBe("");
		expect(extractApiKey(req({ "x-api-key": "" }))).toBe("");
	});
});

describe("isAuthorized", () => {
	test("no expected key → grants access (documented local-adapter mode)", () => {
		expect(isAuthorized(req(), "")).toBe(true);
	});

	test("accepts the key via any of the three supported headers", () => {
		expect(isAuthorized(req({ "x-proxy-api-key": "secret" }), "secret")).toBe(true);
		expect(isAuthorized(req({ "x-api-key": "secret" }), "secret")).toBe(true);
		expect(isAuthorized(req({ authorization: "Bearer secret" }), "secret")).toBe(true);
	});

	test("x-proxy-api-key wins over the other headers", () => {
		expect(
			isAuthorized(req({ "x-proxy-api-key": "secret", "x-api-key": "wrong" }), "secret"),
		).toBe(true);
	});

	test("rejects a mismatched key of equal length", () => {
		expect(isAuthorized(req({ "x-api-key": "secret-124" }), "secret-123")).toBe(false);
	});

	test("rejects a mismatched key of different length without throwing", () => {
		// timingSafeEqual requires equal-length inputs; hashing first means a
		// length mismatch is a value mismatch, not a crash.
		expect(isAuthorized(req({ "x-api-key": "short" }), "a-very-long-secret-key")).toBe(
			false,
		);
	});

	test("rejects a near-miss that differs in a single character", () => {
		expect(isAuthorized(req({ "x-api-key": "secret-abd" }), "secret-abc")).toBe(false);
	});

	test("rejects a request with no credential at all", () => {
		expect(isAuthorized(req(), "secret")).toBe(false);
	});
});
