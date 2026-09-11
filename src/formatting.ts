export type FormatId = "clear" | "bold" | "italic" | "highlight" | "strike" | "underline" | "link" | "code" | "quote" | "codeblock" | "bullet" | "number" | "check" | "rule" | "indent" | "outdent" | `h${1 | 2 | 3 | 4 | 5 | 6}`;

export function transformText(value: string, start: number, end: number, id: FormatId): { value: string; cursor: number } {
  const selected = value.slice(start, end);
  if (!selected && ["clear", "indent", "outdent"].includes(id)) return { value, cursor: start };
  const placeholder = selected || (id === "link" ? "link text" : id === "codeblock" ? "code" : id.startsWith("h") ? "Heading" : "text");
  const replace = (text: string, cursor = start + text.length) => ({ value: value.slice(0, start) + text + value.slice(end), cursor });
  const wrap = (before: string, after: string) => replace(`${before}${placeholder}${after}`, start + before.length + placeholder.length);
  if (id === "bold") return wrap("**", "**");
  if (id === "italic") return wrap("_", "_");
  if (id === "highlight") return wrap("==", "==");
  if (id === "strike") return wrap("~~", "~~");
  if (id === "underline") return wrap("<u>", "</u>");
  if (id === "code") return wrap("`", "`");
  if (id === "link") return replace(`[${placeholder}](https://)`, start + placeholder.length + 11);
  if (id === "codeblock") return replace(`\`\`\`\n${placeholder}\n\`\`\``, start + placeholder.length + 5);
  if (id === "rule") return replace(`${selected ? `${selected}\n\n` : ""}---\n`, start + (selected ? selected.length + 5 : 4));
  if (id === "clear") {
    const cleared = placeholder
      .replace(/<\/?u>/gi, "")
      .replace(/^(#{1,6}|>|- \[[ xX]\]|[-*]|\d+\.)\s+/gm, "")
      .replace(/(\*\*|__|~~|==|`)/g, "")
      .replace(/(^|[^*])\*([^*]|$)/g, "$1$2")
      .replace(/(^|[^_])_([^_]|$)/g, "$1$2");
    return replace(cleared);
  }
  const lines = placeholder.split("\n");
  if (id === "indent") return replace(lines.map((line) => `  ${line}`).join("\n"));
  if (id === "outdent") return replace(lines.map((line) => line.replace(/^(?:  |\t)/, "")).join("\n"));
  const prefix = id === "quote" ? "> " : id === "bullet" ? "- " : id === "check" ? "- [ ] " : id.startsWith("h") ? `${"#".repeat(Number(id.slice(1)))} ` : "";
  return replace(lines.map((line, index) => `${id === "number" ? `${index + 1}. ` : prefix}${line.replace(/^(?:#{1,6}|>|- \[[ xX]\]|[-*]|\d+\.)\s+/, "")}`).join("\n"));
}
