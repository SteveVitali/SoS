import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./renderMarkdown.js";

function toHtml(md: string): string {
  return renderToStaticMarkup(createElement("div", null, renderMarkdown(md)));
}

describe("renderMarkdown", () => {
  // --- Inline formatting ---

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

  // --- Block-level ---

  it("renders horizontal rules", () => {
    expect(toHtml("---")).toContain("<hr/>");
  });

  it("renders line breaks between content lines in same paragraph", () => {
    const html = toHtml("line1\nline2");
    expect(html).toContain("line1<br/>line2");
  });

  it("separates paragraphs on blank lines", () => {
    const html = toHtml("para1\n\npara2");
    expect(html).toContain("<p");
    expect(html).toContain("para1</p>");
    expect(html).toContain("para2</p>");
  });

  it("renders ordered lists", () => {
    const html = toHtml("1. First\n2. Second\n3. Third");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("<li>Second</li>");
    expect(html).toContain("<li>Third</li>");
  });

  it("renders unordered lists with dashes", () => {
    const html = toHtml("- Alpha\n- Beta");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>Alpha</li>");
    expect(html).toContain("<li>Beta</li>");
  });

  it("renders unordered lists with bullets", () => {
    const html = toHtml("• Item A\n• Item B");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>Item A</li>");
    expect(html).toContain("<li>Item B</li>");
  });

  it("renders headings", () => {
    expect(toHtml("# Title")).toContain("<h1>Title</h1>");
    expect(toHtml("## Subtitle")).toContain("<h2>Subtitle</h2>");
    expect(toHtml("### Section")).toContain("<h3>Section</h3>");
  });

  it("renders inline formatting inside list items", () => {
    const html = toHtml("1. **Bold item**\n2. _Italic item_");
    expect(html).toContain("<li><strong>Bold item</strong></li>");
    expect(html).toContain("<li><em>Italic item</em></li>");
  });

  it("renders inline formatting inside headings", () => {
    const html = toHtml("## **Bold** heading");
    expect(html).toContain("<h2><strong>Bold</strong> heading</h2>");
  });

  // --- Complex / integration ---

  it("handles complex PR line in a list", () => {
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

  it("wraps plain text in a paragraph", () => {
    const html = toHtml("just plain text");
    expect(html).toContain("<p");
    expect(html).toContain("just plain text</p>");
  });

  it("handles mixed blocks: paragraph, list, paragraph", () => {
    const md = "Intro text\n\n1. First\n2. Second\n\nConclusion";
    const html = toHtml(md);
    expect(html).toContain("Intro text</p>");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("Conclusion</p>");
  });
});
