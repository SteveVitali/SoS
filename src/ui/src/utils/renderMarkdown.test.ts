import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./renderMarkdown.js";

describe("markdownToHtml", () => {
  it("renders bold", () => {
    expect(markdownToHtml("**hello**")).toContain("<strong>hello</strong>");
  });

  it("renders italic", () => {
    expect(markdownToHtml("_hello_")).toContain("<em>hello</em>");
  });

  it("does not italicize underscores in URLs", () => {
    const html = markdownToHtml("[link](https://example.com/foo_bar)");
    expect(html).not.toContain("<em>");
    expect(html).toContain("foo_bar");
  });

  it("renders links", () => {
    const html = markdownToHtml("[Example](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">Example</a>");
  });

  it("renders inline code", () => {
    expect(markdownToHtml("`code`")).toContain("<code>code</code>");
  });

  it("renders horizontal rules", () => {
    expect(markdownToHtml("---")).toContain("<hr/>");
  });

  it("renders line breaks", () => {
    expect(markdownToHtml("line1\nline2")).toContain("line1<br/>line2");
  });

  it("handles complex PR line", () => {
    const input =
      "• [foursquare/fsq-graph#3035](https://github.com/foursquare/fsq-graph/pull/3035) — fix(crawl): percent-encode _(Feb 25)_";
    const html = markdownToHtml(input);
    expect(html).toContain('href="https://github.com/foursquare/fsq-graph/pull/3035"');
    expect(html).toContain(">foursquare/fsq-graph#3035</a>");
    expect(html).toContain("<em>(Feb 25)</em>");
  });

  it("handles bold title with emoji", () => {
    const html = markdownToHtml("**📂 Your open PRs** — _8 PRs_");
    expect(html).toContain("<strong>📂 Your open PRs</strong>");
    expect(html).toContain("<em>8 PRs</em>");
  });
});
