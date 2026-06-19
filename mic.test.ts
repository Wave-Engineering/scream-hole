import { describe, test, expect, beforeEach } from "bun:test";
import { claim, release, status, _resetLeases, DEFAULT_TTL } from "./mic";

const CH = "chan1";

beforeEach(() => _resetLeases());

describe("mic / lease primitive", () => {
  test("first claim is granted", () => {
    const r = claim("mic", CH, "babelfish", 1000, 0);
    expect(r.granted).toBe(true);
    expect(r.holder).toBe("babelfish");
    expect(r.expiresAt).toBe(1000);
  });

  test("a second holder is refused while held", () => {
    claim("mic", CH, "babelfish", 1000, 0);
    const r = claim("mic", CH, "neuron", 1000, 500);
    expect(r.granted).toBe(false);
    expect(r.holder).toBe("babelfish");
  });

  test("claim succeeds after the lease expires (no deadlock)", () => {
    claim("mic", CH, "babelfish", 1000, 0);
    const r = claim("mic", CH, "neuron", 1000, 1001);
    expect(r.granted).toBe(true);
    expect(r.holder).toBe("neuron");
  });

  test("re-claim by the same holder refreshes the TTL", () => {
    claim("mic", CH, "babelfish", 1000, 0);
    const r = claim("mic", CH, "babelfish", 1000, 500);
    expect(r.granted).toBe(true);
    expect(r.expiresAt).toBe(1500);
  });

  test("only the holder may release", () => {
    claim("mic", CH, "babelfish", 1000, 0);
    expect(release("mic", CH, "neuron", 100)).toEqual({ released: false, holder: "babelfish" });
    expect(release("mic", CH, "babelfish", 100)).toEqual({ released: true });
    // freed → next claimer gets it
    expect(claim("mic", CH, "neuron", 1000, 200).granted).toBe(true);
  });

  test("release is idempotent on a free/expired lease", () => {
    expect(release("mic", CH, "whoever", 0)).toEqual({ released: true });
  });

  test("status reflects holder and expiry; null when free/expired", () => {
    expect(status("mic", CH, 0)).toBeNull();
    claim("mic", CH, "babelfish", 1000, 0);
    expect(status("mic", CH, 500)).toEqual({ holder: "babelfish", expiresAt: 1000 });
    expect(status("mic", CH, 1001)).toBeNull();
  });

  test("mic and send are independent leases on the same channel", () => {
    claim("mic", CH, "babelfish", 1000, 0);
    const r = claim("send", CH, "neuron", 1000, 0);
    expect(r.granted).toBe(true); // send lease is separate from mic
  });

  test("default TTLs are sane (mic longer than send)", () => {
    expect(DEFAULT_TTL.mic).toBeGreaterThan(DEFAULT_TTL.send);
  });
});
