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

/**
 * Convert standard markdown → Slack mrkdwn.
 * Applied before sending messages to Slack so that headings, links,
 * and tables render correctly in Slack's format.
 */
export function markdownToSlack(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Markdown headings → bold
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      out.push(`*${headingMatch[2]}*`);
      i++;
      continue;
    }

    // Detect markdown table: current line has pipes and next line is a separator (|---|---| etc.)
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      // Parse the table header
      const headers = parseTableCells(line);
      i += 2; // skip header + separator

      // Collect data rows
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(parseTableCells(lines[i]));
        i++;
      }

      // Render as readable list: each row becomes "*Header1:* value1 \u2014 *Header2:* value2"
      for (const row of rows) {
        const parts: string[] = [];
        for (let col = 0; col < headers.length && col < row.length; col++) {
          if (row[col]) {
            parts.push(`*${headers[col]}:* ${row[col]}`);
          }
        }
        out.push(`• ${parts.join(" — ")}`);
      }
      continue;
    }

    // Markdown bold **text** → Slack bold *text*, then markdown links → Slack links
    const converted = line
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");
    out.push(converted);
    i++;
  }

  return out.join("\n");
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|", 1);
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s-:|]+\|[\s-:|]+\|?$/.test(line.trim());
}

function parseTableCells(line: string): string[] {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
}
