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
/** Indentation width of a line, or -1 when the line has no content. */
function indentOf(line) {
    if (line.trim().length === 0)
        return -1;
    return line.length - line.trimStart().length;
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
export function splitPatchDocument(lines) {
    const starts = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (/^-\s/.test(line))
            starts.push(i);
    }
    const items = [];
    for (let index = 0; index < starts.length; index += 1) {
        const start = starts[index] ?? 0;
        const end = starts[index + 1] ?? lines.length;
        let id;
        for (let i = start; i < end; i += 1) {
            const match = /^\s*-?\s*id:\s*(\S+)\s*$/.exec(lines[i] ?? '');
            if (match?.[1] !== undefined) {
                id = match[1];
                break;
            }
        }
        items.push({ ...(id === undefined ? {} : { id }), start, end });
    }
    const firstStart = starts[0] ?? lines.length;
    return { preamble: lines.slice(0, firstStart), items };
}
/**
 * Find a nested key inside one item.
 *
 * The block runs from the `key:` line up to the next line whose indentation is
 * no deeper, skipping blank lines and comments so a comment immediately after a
 * block is not swallowed.
 *
 * @param lines - all lines of the file.
 * @param item - the item to search.
 * @param key - the key name, without the colon.
 * @returns the block, or undefined when the item has no such key.
 */
function findKeyBlock(lines, item, key) {
    const pattern = new RegExp(`^(\\s+)${key}:`);
    for (let i = item.start; i < item.end; i += 1) {
        const line = lines[i] ?? '';
        const match = pattern.exec(line);
        if (match === null)
            continue;
        const baseIndent = match[1]?.length ?? 0;
        let end = i + 1;
        while (end < item.end) {
            const next = lines[end] ?? '';
            const nextIndent = indentOf(next);
            // A blank line or a comment belongs to nobody; stop rather than absorb it
            // into the block, so trailing comments stay where the user put them.
            if (nextIndent === -1)
                break;
            if (nextIndent <= baseIndent)
                break;
            end += 1;
        }
        return { keyLine: i, end };
    }
    return undefined;
}
/**
 * Render a `config` value as YAML text at the given indentation.
 *
 * A single-line JSON object is emitted inline, matching how the detectors
 * already phrase their snippets; anything else is emitted as a nested block so
 * deep configs stay readable.
 *
 * @param configJson - the config as JSON text.
 * @param keyIndent - indentation of the `config:` key itself.
 * @returns the replacement lines, starting with `config:`.
 */
function renderConfig(configJson, keyIndent) {
    const pad = ' '.repeat(keyIndent);
    let parsed;
    try {
        parsed = JSON.parse(configJson);
    }
    catch {
        return [`${pad}config: ${configJson}`];
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [`${pad}config: ${JSON.stringify(parsed)}`];
    }
    const entries = Object.entries(parsed);
    // Short, flat, scalar-only configs read better inline and match the existing
    // snippet style, so the diff stays one line.
    const scalarOnly = entries.every(([, value]) => value === null || typeof value !== 'object');
    const inline = JSON.stringify(parsed);
    if (scalarOnly && inline.length <= 100)
        return [`${pad}config: ${inline}`];
    const out = [`${pad}config:`];
    const childPad = ' '.repeat(keyIndent + 2);
    for (const [key, value] of entries)
        out.push(`${childPad}${key}: ${JSON.stringify(value)}`);
    return out;
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
export function readSnippetChange(snippet) {
    const idMatch = /^\s*-?\s*id:\s*(\S+)\s*$/m.exec(snippet);
    const rowId = idMatch?.[1];
    if (rowId === undefined)
        return undefined;
    if (/^\s*disabled:\s*true\s*$/m.test(snippet))
        return { rowId, key: 'disabled', value: 'true' };
    const configMatch = /^\s*config:\s*(.+)$/m.exec(snippet);
    if (configMatch?.[1] !== undefined)
        return { rowId, key: 'config', value: configMatch[1].trim() };
    return undefined;
}
/**
 * Apply one fix snippet to a patch file's text.
 *
 * @param source - the current file text.
 * @param snippet - the snippet to apply.
 * @returns the new text and what changed, or undefined when the snippet is not a
 *   shape this can apply safely.
 */
export function applySnippet(source, snippet) {
    const change = readSnippetChange(snippet);
    if (change === undefined)
        return undefined;
    const hadTrailingNewline = source.endsWith('\n');
    const lines = source.split('\n');
    if (hadTrailingNewline)
        lines.pop();
    const document = splitPatchDocument(lines);
    const item = document.items.find((entry) => entry.id === change.rowId);
    const out = [...lines];
    if (item === undefined) {
        // Not present: append a new item, which is how a patch layer adds a change
        // for a row an earlier layer inserted. Confined to a new top-level entry, so
        // nothing the user wrote is disturbed.
        const block = change.key === 'disabled'
            ? [`- id: ${change.rowId}`, `  disabled: ${change.value}`]
            : [`- id: ${change.rowId}`, ...renderConfig(change.value, 2)];
        const separator = out.length > 0 && (out[out.length - 1] ?? '').trim().length > 0 ? [''] : [];
        out.push(...separator, ...block);
        return { text: out.join('\n') + (hadTrailingNewline ? '\n' : ''), rowId: change.rowId, action: 'appended', changed: true };
    }
    const existing = findKeyBlock(lines, item, change.key);
    const replacement = change.key === 'disabled' ? [`  disabled: ${change.value}`] : renderConfig(change.value, 2);
    if (existing === undefined) {
        // Append the key at the end of this item, before whatever follows it.
        out.splice(item.end, 0, ...replacement);
        return { text: out.join('\n') + (hadTrailingNewline ? '\n' : ''), rowId: change.rowId, action: 'appended', changed: true };
    }
    const before = out.slice(existing.keyLine, existing.end);
    if (before.join('\n') === replacement.join('\n')) {
        return { text: source, rowId: change.rowId, action: 'replaced', changed: false };
    }
    out.splice(existing.keyLine, existing.end - existing.keyLine, ...replacement);
    return { text: out.join('\n') + (hadTrailingNewline ? '\n' : ''), rowId: change.rowId, action: 'replaced', changed: true };
}
