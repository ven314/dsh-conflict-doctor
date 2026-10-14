/**
 * Surgical edits to a `cordis.patch.yml`, preserving everything not targeted.
 *
 * Reading the file with a YAML parser and writing it back would discard every
 * comment and reorder every key — and this file is the user's own hand-written
 * configuration layer. So the edit is textual: locate the one item by `id`, then
 * replace only the KEY that changes.
 *
 * Replacing the whole item would be simpler and wrong. A user's item may look
 * like:
 *
 *     - id: ui-chat
 *       name: "@deepseek-ai/dsh-client-ui-chat"
 *       config:
 *         transcriptView: standard
 *
 * A "disable this row" repair that swapped the item for `- id: ui-chat` +
 * `disabled: true` would silently drop the name and the config. Whether that
 * matters is arguable; losing a user's configuration without being asked is not.
 * So `disabled` is merged into the existing item and only `config` is replaced.
 *
 * Nothing here writes to disk. It returns new text, and the caller decides.
 *
 * @module dsh-conflict-doctor/patch-edit
 */
/** One top-level array item and the lines it occupies. */
export interface PatchItem {
    /** The `id:` value, when the item declares one. */
    readonly id?: string;
    /** First line index (inclusive), pointing at the `- ` itself. */
    readonly start: number;
    /** One past the last line belonging to this item. */
    readonly end: number;
}
/** The lines before the first top-level item: comments and blank lines. */
export interface PatchDocument {
    readonly preamble: readonly string[];
    readonly items: readonly PatchItem[];
}
/**
 * Split a patch file into its preamble and top-level items.
 *
 * A top-level item starts at a line beginning with `- ` at column 0. Anything
 * before the first such line is preamble and is never touched.
 *
 * @param lines - the file split into lines.
 * @returns the preamble and the item ranges.
 */
export declare function splitPatchDocument(lines: readonly string[]): PatchDocument;
/** What one edit did. */
export interface EditResult {
    readonly text: string;
    /** The row the edit addressed. */
    readonly rowId: string;
    /** Whether an existing key was rewritten or a new one appended. */
    readonly action: 'replaced' | 'appended';
    /** Whether the file changed at all. */
    readonly changed: boolean;
}
/**
 * Read the change a fix snippet asks for.
 *
 * Only the two shapes the audit emits are recognised: a disable, and a config
 * replacement. Anything else is refused rather than guessed at, because a
 * mis-read snippet would corrupt the user's file.
 *
 * @param snippet - a paste-ready patch fragment.
 * @returns the row, the key, and the value text, or undefined when unrecognised.
 */
export declare function readSnippetChange(snippet: string): {
    rowId: string;
    key: 'disabled' | 'config';
    value: string;
} | undefined;
/**
 * Apply one fix snippet to a patch file's text.
 *
 * @param source - the current file text.
 * @param snippet - the snippet to apply.
 * @returns the new text and what changed, or undefined when the snippet is not a
 *   shape this can apply safely.
 */
export declare function applySnippet(source: string, snippet: string): EditResult | undefined;
