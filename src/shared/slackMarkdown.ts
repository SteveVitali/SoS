/** Convert Slack-style markdown to standard markdown. Used server-side to normalize messages before storage. */
export function slackToMarkdown(text: string): string {
  return (
    text
      // Slack bold *text* → markdown bold **text** (but not ** which is already markdown)
      .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "**$1**")
      // Slack links <url|label> → markdown [label](url)
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      // Bare Slack links <url> → markdown [url](url)
      .replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)")
  );
}
