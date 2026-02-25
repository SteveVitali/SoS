import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./renderMarkdown.js";

function toHtml(md: string): string {
  return renderToStaticMarkup(createElement("div", null, renderMarkdown(md)));
}

describe("renderMarkdown", () => {
  it("renders bold", () => {
    expect(toHtml("**hello**")).toContain("<strong>hello</strong>");
  });

  it("renders italic", () => {
    expect(toHtml("_hello_")).toContain("<em>hello</em>");
  });

  it("does not italicize underscores in URLs", () => {
    const html = toHtml("[link](https://example.com/foo_bar)");
    expect(html).not.toContain("<em>");
    expect(html).toContain("foo_bar");
  });

  it("renders links with target=_blank", () => {
    const html = toHtml("[Example](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain(">Example</a>");
  });

  it("renders inline code", () => {
    expect(toHtml("`code`")).toContain("<code>code</code>");
  });

  it("renders horizontal rules", () => {
    expect(toHtml("---")).toContain("<hr/>");
  });

  it("renders line breaks between content lines", () => {
    const html = toHtml("line1\nline2");
    expect(html).toContain("line1<br/>line2");
  });

  it("does not emit orphan breaks for empty lines", () => {
    const html = toHtml("line1\n\nline2");
    // Should not have consecutive <br> tags
    expect(html).not.toContain("<br/><br/>");
    expect(html).toContain("line1");
    expect(html).toContain("line2");
  });

  it("handles complex PR line", () => {
    const input =
      "• [org/repo#3035](https://github.com/org/repo/pull/3035) — fix: something _(Feb 25)_";
    const html = toHtml(input);
    expect(html).toContain('href="https://github.com/org/repo/pull/3035"');
    expect(html).toContain(">org/repo#3035</a>");
    expect(html).toContain("<em>(Feb 25)</em>");
  });

  it("handles bold title with emoji", () => {
    const html = toHtml("**📂 Your open PRs** — _8 PRs_");
    expect(html).toContain("<strong>📂 Your open PRs</strong>");
    expect(html).toContain("<em>8 PRs</em>");
  });

  it("returns plain text for input without markdown", () => {
    const html = toHtml("just plain text");
    expect(html).toBe("<div>just plain text</div>");
  });
});
