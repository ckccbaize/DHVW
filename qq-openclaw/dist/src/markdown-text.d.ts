/**
 * Markdown → plain text for QQ.
 *
 * QQ renders nothing: a reply goes out as literal characters, so an agent's
 * `## 今日总结` / `**周四**` / `- 待办` arrives with all its syntax showing. This
 * module flattens that markup into text that reads correctly in a chat bubble —
 * headings become bracketed lines, bullets become `•`, emphasis markers are
 * dropped while their words stay, and link targets are kept in parentheses
 * because a QQ message has nothing to click.
 *
 * Deliberately hand-rolled and dependency-free: it runs inside the plugin entry
 * graphs, where a bare runtime import is forbidden (see CLAUDE.md), and the
 * subset of Markdown an agent actually emits is small enough that a parser
 * would be more risk than help. Every rule is line-oriented and total — unknown
 * or malformed markup falls through as its own text rather than being dropped.
 */
/**
 * Flatten a Markdown reply into chat-readable plain text.
 *
 * Never throws and never drops content: anything it does not recognise is
 * passed through verbatim.
 */
export declare function markdownToText(markdown: string): string;
//# sourceMappingURL=markdown-text.d.ts.map