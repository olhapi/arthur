import TurndownService from "turndown";

const MEDIA_PLACEHOLDER = /arthur-media:\/\/([A-Za-z0-9_-]+)/g;

function tableCellText(cell: HTMLTableCellElement): string {
  return (cell.textContent ?? "").trim().replaceAll("|", "\\|").replace(/\s+/g, " ");
}

function tableRow(row: HTMLTableRowElement): string {
  const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(":scope > th, :scope > td"));
  return `| ${cells.map(tableCellText).join(" | ")} |`;
}

export function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
  });

  turndown.addRule("fencedCodeBlock", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_content, node) => {
      const code = node.querySelector("code");
      const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "";
      const source = (code?.textContent ?? node.textContent ?? "").trim();
      return `\n\n\`\`\`${language}\n${source}\n\`\`\`\n\n`;
    },
  });
  turndown.addRule("strikethrough", {
    filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });
  turndown.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = Array.from(node.querySelectorAll<HTMLTableRowElement>("tr"));
      if (rows.length === 0) {
        return "";
      }
      const [header, ...body] = rows;
      if (header === undefined) {
        return "";
      }
      const columns = header.querySelectorAll(":scope > th, :scope > td").length;
      const separator = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
      return `\n\n${tableRow(header)}\n${separator}\n${body.map(tableRow).join("\n")}\n\n`;
    },
  });

  return turndown.turndown(html).replace(/\r\n?/g, "\n").trim();
}

export function finalizeMarkdown(markdown: string, resolved: ReadonlyMap<string, string>): string {
  return markdown.replace(MEDIA_PLACEHOLDER, (placeholder, id: string) => {
    const filename = resolved.get(id);
    return filename === undefined ? placeholder : `![[attachments/${filename}]]`;
  });
}
