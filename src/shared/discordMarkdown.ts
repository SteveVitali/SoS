/**
 * Convert Discord-style text to standard markdown.
 * Discord already uses standard markdown, so this mainly normalizes
 * Discord-specific syntax like user/channel/role mentions.
 */
export function discordToMarkdown(text: string): string {
  return (
    text
      // Discord user mentions <@123456> or <@!123456> → @user
      .replace(/<@!?(\d+)>/g, "@user:$1")
      // Discord channel mentions <#123456> → #channel
      .replace(/<#(\d+)>/g, "#channel:$1")
      // Discord role mentions <@&123456> → @role
      .replace(/<@&(\d+)>/g, "@role:$1")
      // Discord custom emoji <:name:123456> → :name:
      .replace(/<a?:(\w+):\d+>/g, ":$1:")
  );
}

/**
 * Convert standard markdown → Discord markdown.
 * Discord natively supports standard markdown, so this is mostly a passthrough.
 * Only transforms Slack-style formatting if present.
 */
export function markdownToDiscord(text: string): string {
  // Discord supports standard markdown natively — no conversion needed.
  // Just ensure Slack-style formatting doesn't leak through.
  return (
    text
      // Slack bold *text* (single asterisks that aren't already markdown bold)
      // Leave **text** alone since Discord handles it natively
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      // Bare Slack links <url> → markdown [url](url)
      .replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)")
  );
}
