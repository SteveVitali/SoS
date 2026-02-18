import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("converts simple text to a slug", () => {
    expect(slugify("Fix the login bug")).toBe("fix-the-login-bug");
  });

  it("strips Slack user mentions", () => {
    expect(slugify("fix auth <@U12345>")).toBe("fix-auth");
  });

  it("collapses multiple non-alphanumeric characters", () => {
    expect(slugify("hello!!!world---foo")).toBe("hello-world-foo");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("truncates to maxLen", () => {
    const long = "a".repeat(100);
    expect(slugify(long, 10)).toBe("a".repeat(10));
  });

  it("does not end with a hyphen after truncation", () => {
    expect(slugify("hello-world-this-is-long", 12)).toBe("hello-world");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles pure special characters", () => {
    expect(slugify("!@#$%^&*()")).toBe("");
  });
});
