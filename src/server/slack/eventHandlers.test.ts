import { describe, expect, it } from "vitest";
import { parseModifiers } from "./eventHandlers.js";

describe("parseModifiers", () => {
  it("extracts repo= hint", () => {
    expect(parseModifiers("fix the bug repo=fsq-graph")).toEqual({
      repo_hint: "fsq-graph",
    });
  });

  it("extracts tests= level", () => {
    expect(parseModifiers("fix it tests=full")).toEqual({
      test_level: "full",
    });
  });

  it("is case-insensitive for tests= value", () => {
    expect(parseModifiers("fix it tests=FAST")).toEqual({
      test_level: "fast",
    });
  });

  it("extracts ci_fix=on", () => {
    expect(parseModifiers("fix it ci_fix=on")).toEqual({
      ci_fix_enabled: true,
    });
  });

  it("extracts ci_fix=off", () => {
    expect(parseModifiers("fix it ci_fix=off")).toEqual({
      ci_fix_enabled: false,
    });
  });

  it("extracts review= with multiple comma-separated reviewers", () => {
    expect(parseModifiers("fix it review=@alice,@bob,charlie")).toEqual({
      reviewers: ["alice", "bob", "charlie"],
    });
  });

  it("strips @ prefix from reviewers", () => {
    const result = parseModifiers("review=@user1");
    expect(result.reviewers).toEqual(["user1"]);
  });

  it("extracts all modifiers at once", () => {
    const result = parseModifiers(
      "fix auth repo=foursquare.web tests=fast ci_fix=on review=@alice",
    );
    expect(result).toEqual({
      repo_hint: "foursquare.web",
      test_level: "fast",
      ci_fix_enabled: true,
      reviewers: ["alice"],
    });
  });

  it("returns empty object when no modifiers present", () => {
    expect(parseModifiers("just fix the login page")).toEqual({});
  });

  it("handles tests=none", () => {
    expect(parseModifiers("tests=none")).toEqual({ test_level: "none" });
  });

  it("does not match partial keywords", () => {
    // "repost=foo" should not match repo=
    expect(parseModifiers("repost=foo")).toEqual({});
  });
});
