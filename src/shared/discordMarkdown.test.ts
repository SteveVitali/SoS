import { describe, expect, it } from "vitest";
import { discordToMarkdown, markdownToDiscord } from "./discordMarkdown.js";

describe("discordToMarkdown", () => {
  it("converts user mentions to plain text", () => {
    expect(discordToMarkdown("Hello <@123456>!")).toBe("Hello @user:123456!");
  });

  it("converts nick-style user mentions", () => {
    expect(discordToMarkdown("Hello <@!123456>!")).toBe("Hello @user:123456!");
  });

  it("converts channel mentions", () => {
    expect(discordToMarkdown("Check <#987654>")).toBe("Check #channel:987654");
  });

  it("converts role mentions", () => {
    expect(discordToMarkdown("Ping <@&111222>")).toBe("Ping @role:111222");
  });

  it("converts custom emoji to shortcodes", () => {
    expect(discordToMarkdown("Nice <:thumbsup:123>")).toBe("Nice :thumbsup:");
    expect(discordToMarkdown("Nice <a:wave:456>")).toBe("Nice :wave:");
  });

  it("passes through standard markdown", () => {
    const md = "**bold** _italic_ `code`";
    expect(discordToMarkdown(md)).toBe(md);
  });
});

describe("markdownToDiscord", () => {
  it("converts Slack-style links to markdown links", () => {
    expect(markdownToDiscord("<https://example.com|Example>")).toBe(
      "[Example](https://example.com)",
    );
  });

  it("converts bare Slack links to markdown links", () => {
    expect(markdownToDiscord("<https://example.com>")).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  it("passes through standard markdown unchanged", () => {
    const md = "**bold** _italic_ [link](https://example.com)";
    expect(markdownToDiscord(md)).toBe(md);
  });
});
