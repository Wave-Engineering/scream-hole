import { test, expect, describe } from "bun:test";

/**
 * Guards against the README and the code drifting apart.
 *
 * #25 added a provenance contract to the README that quotes exact response
 * bodies, and consumers are told to match on them. Nothing enforced that the
 * quotes were real: renaming an error string in `index.ts` left the README
 * silently wrong, with no test anywhere going red. That is the same drift class
 * #26 exists to fix on the endpoint table, one level down — a doc making a
 * promise the code is free to break.
 *
 * The check runs README -> source, never the reverse. The README documents a
 * deliberate SUBSET of the proxy's errors (the catch-all and the two
 * attribution failures); asserting every `proxyError()` site were documented
 * would red the suite for errors nobody ever intended to publish.
 */

const README = await Bun.file(new URL("../README.md", import.meta.url).pathname).text();
const SOURCE = await Bun.file(new URL("../index.ts", import.meta.url).pathname).text();

/** An `"error": "…"` key/value, wherever it appears. */
const ERROR_KEY = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Every error body the README quotes, keyed on `"error"` appearing ANYWHERE in
 * the quote rather than as the first key with a status glued to the brace.
 *
 * That looseness is deliberate and was a real bug in the first version of this
 * file. The strict form silently missed two shapes a future author would write
 * without a second thought — `{"proxy": …, "error": …}` (keys swapped) and a
 * body mentioned in prose with no adjacent status — and the vacuity floor below
 * could not catch either, because the three existing quotes satisfy it on their
 * own. A guard whose blind spot is "the next quote somebody adds" is worse than
 * no guard: the README grows an unchecked claim while the suite reports green.
 *
 * `"error"` is still the right discriminator for scanning the whole file: a
 * proxy body has `error` + `proxy`, a Discord body has `message` + `code`. The
 * genuine `404 {"message":"Unknown Message","code":10008}` the README also
 * quotes is therefore not picked up — correctly, since it is Discord's string
 * and not ours to keep in sync.
 */
const documentedBodies = [...README.matchAll(new RegExp(ERROR_KEY, "g"))].map((m) => m[1]!);

/**
 * The subset of those quotes that also carry a status code, so the status can
 * be checked too. Matches a braced group preceded by a 3-digit status and then
 * looks for `error` INSIDE it — order-insensitive, unlike the first version.
 *
 * Not every quote can be status-paired (prose may cite a body without one), so
 * this is a subset by design; existence for all of them is covered above.
 */
const documentedPairs = [...README.matchAll(/(\d{3})\s*(\{[^}]*\})/g)].flatMap((m) => {
  const error = m[2]!.match(ERROR_KEY);
  return error ? [{ status: Number(m[1]), error: error[1]! }] : [];
});

/**
 * `{status, error}` pairs actually constructed by `proxyError()` in `index.ts`.
 *
 * `\s*` between the tokens rather than a single-line match: one call site (the
 * `after` 400) wraps its arguments across three lines, and a line-anchored
 * regex would silently omit it — a miss here weakens the check without failing
 * it, so the extractor is written to tolerate the formatting the file actually
 * uses. The optional trailing comma is for that same wrapped site.
 *
 * The `function proxyError(error: string, ...)` definition does not match (no
 * quote follows the paren), nor do the prose mentions of `proxyError()` in the
 * doc comments.
 */
const constructed = [
  ...SOURCE.matchAll(/proxyError\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,?\s*\)/g),
].map((m) => ({ status: Number(m[2]), error: m[1]! }));

describe("README quotes real response bodies (#26)", () => {
  // Vacuity guard, and the reason it comes first: the two pairing tests below
  // each loop over one of the two collections, so if the provenance section
  // were deleted or reworded past recognition, that collection would be empty
  // and its test would pass over an empty loop — green, while the thing it
  // guards had vanished. A silent pass is the failure mode this file exists to
  // prevent, so it is checked explicitly.
  //
  // BOTH collections are floored, not just the first. An earlier version floored
  // only `documentedBodies`, which left the status half — the half with
  // consequences, since the README's retry guidance keys off the status —
  // able to go vacuous on its own: move the statuses out of the quoted braces
  // (a status column in the failure table, or "returns 502 with body `{…}`")
  // and `documentedPairs` empties while the floor above stays satisfied.
  //
  // A floor, not an exact count: WHICH errors the README publishes is an
  // editorial choice, and documenting a fourth should not red the suite. The
  // three are the 501 catch-all and the 502/500 attribution pair from #25.
  test("the README still quotes proxy-originated bodies at all", () => {
    expect(documentedBodies.length).toBeGreaterThanOrEqual(3);
    expect(documentedPairs.length).toBeGreaterThanOrEqual(3);
  });

  test("the extractor finds the proxyError call sites", () => {
    // Companion vacuity guard for the other side. If a refactor renamed the
    // helper or changed its signature, `constructed` would empty out and every
    // pairing below would fail — but with a confusing "not found" for each
    // string rather than the real cause, which is stated here instead.
    expect(constructed.length).toBeGreaterThanOrEqual(documentedBodies.length);
  });

  test("every body the README quotes is really constructed by the proxy", () => {
    for (const error of documentedBodies) {
      expect(
        constructed.some((c) => c.error === error),
        `README quotes an error no proxyError() call constructs: "${error}"`,
      ).toBe(true);
    }
  });

  // Split from the existence check above because the two failures mean
  // different things: a missing string is a renamed error, a mismatched status
  // is a changed contract — and the README tells consumers whether to RETRY
  // based on that status, so it is the half with consequences.
  test("every quoted status matches EVERY site that constructs that body", () => {
    for (const pair of documentedPairs) {
      const sites = constructed.filter((c) => c.error === pair.error);
      expect(sites.length, `no proxyError() call constructs "${pair.error}"`).toBeGreaterThan(0);
      // `filter` + all-must-agree, not `find`. With `find` this asserted only
      // that SOME site paired correctly, while the limits below claimed the
      // quoted body "pairs with its status" — an overclaim, and reachable:
      // "Write pass-through is not configured (no Discord client)" is
      // constructed at two sites. They agree on 503 today and neither is
      // quoted, so there was no live defect — but the check would have gone
      // green on a future divergence, which is what made it worth changing.
      for (const site of sites) {
        expect(
          site.status,
          `README documents "${pair.error}" as ${pair.status}, a call site returns ${site.status}`,
        ).toBe(pair.status);
      }
    }
  });
});

/**
 * LIMITS — stated adjacent, per the rule this repo applies to its other
 * source-derived checks. A tripwire a reader over-trusts is worse than none.
 *
 *  - It proves the STRINGS still exist and, where a status is quoted alongside,
 *    that every site constructing that string uses it. It says nothing about
 *    whether the documented SEMANTICS are still accurate. Changing WHEN a 502
 *    is raised — the exact defect #25 was about — passes this check untouched.
 *    That claim is guarded behaviourally in tests/index.test.ts ("upstream
 *    failure is attributable"), not here.
 *  - A quote with no status adjacent to it gets its string checked but not its
 *    status. There is nothing to compare against, so this is a real gap rather
 *    than an oversight — prefer quoting `<status> {…}` so both halves apply.
 *  - It cannot see a route that returns an undocumented error, by design (see
 *    the header): README -> source only.
 *  - The SOURCE extractor reads double-quoted literals only. The uncached-guild
 *    404 uses a template literal and is therefore invisible to it. That is safe
 *    today because the README does not quote it, and safe tomorrow in the right
 *    direction: quoting it would make the existence test FAIL loudly rather than
 *    pass silently. Fix that by extending the extractor, never by deleting the
 *    quote. The README extractor has no equivalent blind spot ON THE EXISTENCE
 *    CHECK — `documentedBodies` finds an `"error"` key anywhere, which is why
 *    it replaced the strict version that missed swapped keys silently. The
 *    status check is narrower: `documentedPairs` stops its braced group at the
 *    first `}`, so a quoted body whose `"error"` key appears AFTER a nested
 *    object would have its string checked but not its status. A nested object
 *    after the `"error"` key is harmless — the truncated group still contains
 *    the key, so the pair still forms. Unreachable either way today, since
 *    `proxyError` only ever emits a flat `{error, proxy}`; recorded rather than
 *    fixed because the fix would be speculative. Stated this narrowly on
 *    purpose: a limit described more broadly than it is reads as noise to the
 *    next person who tests it, and then none of these bullets get believed.
 *  - Nothing here checks the endpoint TABLE against the router. A row naming a
 *    path that does not exist still passes, and so does a route added without a
 *    row. That guard is a behavioural probe of the handler rather than a text
 *    match, so it is a different mechanism, not an extension of this one; #26
 *    scoped it out deliberately and it is tracked in #31. The table was verified
 *    against the router BY HAND at #26 and has no standing check until then.
 */
