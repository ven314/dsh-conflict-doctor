/**
 * Repair plans: what a fix will actually DO to a profile, and how dangerous that is.
 *
 * Until now every `Fix` was a label plus a paste-ready snippet, and nothing ever
 * checked the snippet. The README's promise — "it never modifies configuration" —
 * held only because nothing applied anything. That changes the moment a fix can
 * be applied, so the risk has to be derived from the snippet itself rather than
 * from a hand-written label that can drift away from what the YAML says.
 *
 * Risk is therefore COMPUTED, at one choke point in `detect()`, from the fix's
 * own kind and snippet. Annotating ~29 construction sites by hand would drift the
 * first time someone edited a snippet and forgot the label.
 *
 * @module dsh-conflict-doctor/fix
 */
/**
 * Which risks `--apply` may take WITHOUT being asked specifically.
 *
 * Deliberately excludes `destructive`. Disabling a row changes which plugins
 * run, and the audit cannot know whether the disabled row was load-bearing —
 * that is a decision only the user can make. A tool that quietly disables things
 * is exactly the "governance plugin becomes the fault" failure this project
 * exists to avoid.
 */
export const AUTO_APPLICABLE = new Set(['safe', 'caution']);
/**
 * Whether an automated apply may include this fix.
 *
 * Takes the whole fix rather than just its risk, because risk alone cannot
 * answer the question. A `manual` fix is graded `safe` — nothing is applied, so
 * nothing can break — but it is NOT applicable: the decision is the user's, and
 * there is no snippet to write. An earlier version of this function took only
 * the risk level, which classified every manual fix as auto-applicable.
 *
 * `destructive` is excluded deliberately: disabling a row changes which plugins
 * run, and the audit cannot know whether that row was load-bearing. A tool that
 * quietly disables things is the "governance plugin becomes the fault" failure
 * this project exists to prevent.
 *
 * @param fix - the fix to judge, needing at least its kind and risk.
 * @returns true when `--apply` may take it without an explicit opt-in.
 */
export function isAutoApplicable(fix) {
    // Only a patch is a mechanical change. A command's effect is invisible to the
    // audit; a manual decision has nothing to execute.
    if (fix.kind !== 'patch')
        return false;
    const risk = fix.risk ?? classifyRisk(fix.kind, undefined);
    return AUTO_APPLICABLE.has(risk);
}
/**
 * Classify a fix from its own kind and snippet.
 *
 * The snippet is the authority, not the label: a `patch` whose YAML says
 * `disabled: true` is destructive no matter how it is described, and a patch
 * that only inserts rows cannot break anything that already works.
 *
 * @param kind - the fix kind.
 * @param snippet - the patch fragment, when present.
 * @returns the risk level.
 */
export function classifyRisk(kind, snippet) {
    // A manual decision applies nothing, so it cannot be dangerous. Treating it as
    // `safe` would be wrong though — it is not auto-applicable at all, which
    // `isAutoApplicable` already excludes by kind.
    if (kind === 'manual')
        return 'safe';
    // A command runs in the profile; the audit cannot see what it does.
    if (kind === 'command')
        return 'destructive';
    if (snippet === undefined)
        return 'caution';
    // `disabled: true` changes which rows load. Checked before config, because a
    // snippet may legitimately contain both.
    if (/^\s*disabled:\s*true\s*$/m.test(snippet))
        return 'destructive';
    // A `config:` replacement overwrites whatever an earlier layer wrote. The old
    // value is only recoverable from the backup, so it is not free.
    if (/^\s*config:/m.test(snippet))
        return 'caution';
    // An insert list adds rows without touching existing ones.
    if (/^\s*-\s*insert:/m.test(snippet) || /^\s*insert:/m.test(snippet))
        return 'safe';
    return 'caution';
}
/**
 * Whether a fix is a manual decision rather than an applicable change.
 *
 * @param kind - the fix kind.
 * @returns true when nothing can be applied.
 */
export function isManual(kind) {
    return kind === 'manual';
}
/**
 * Human label for a risk level.
 *
 * Names the consequence rather than the category, because "destructive" alone
 * does not tell a reader whether their tools will stop loading.
 */
export const RISK_LABEL = {
    safe: '安全（只新增，不改既有行）',
    caution: '需谨慎（覆盖既有行的 config，可从备份恢复）',
    destructive: '有破坏性（停用/删除行或执行命令，会改变实际加载的内容）',
};
/**
 * Read the row a patch snippet addresses.
 *
 * The snippet is YAML text, so this reads the `- id:` line rather than parsing
 * the whole document: the audit never evaluates or rewrites user YAML outside an
 * explicit apply, and an approximate read is enough to detect that two fixes
 * point at the same row.
 *
 * @param snippet - a paste-ready patch fragment.
 * @returns the row id it addresses, or undefined when it addresses none.
 */
export function snippetRowId(snippet) {
    if (snippet === undefined)
        return undefined;
    const match = /^\s*-?\s*id:\s*(\S+)\s*$/m.exec(snippet);
    return match?.[1];
}
/**
 * What one fix does, from its kind and snippet.
 *
 * @param fix - the fix to classify.
 * @returns the change it makes.
 */
export function classifyChange(fix) {
    if (fix.kind !== 'patch' || fix.snippet === undefined)
        return 'unknown';
    if (/^\s*disabled:\s*true\s*$/m.test(fix.snippet))
        return 'disable-row';
    if (/^\s*config:/m.test(fix.snippet))
        return 'set-config';
    if (/^\s*(-\s*)?insert:/m.test(fix.snippet))
        return 'insert-row';
    return 'unknown';
}
/**
 * Find rows that two or more fixes would change incompatibly.
 *
 * Two fixes touching one row is not automatically a conflict: two findings may
 * legitimately both add rows to the same `insert` list. It becomes a conflict
 * when their effects disagree — one disabling a row while another reconfigures
 * it, for instance. Applying both silently loses one of them, and which one is
 * lost depends on ordering, so the audit says so instead of guessing.
 *
 * @param findings - findings whose fixes have already been grouped.
 * @returns one entry per conflicting row, sorted by row id.
 */
export function findFixConflicts(findings) {
    const byRow = new Map();
    for (const finding of findings) {
        for (const fix of finding.fixes) {
            const rowId = snippetRowId(fix.snippet);
            if (rowId === undefined)
                continue;
            const change = classifyChange(fix);
            // Only mechanical changes to an existing row can collide. An insert that
            // adds a row and a config that replaces one are different targets.
            if (change !== 'set-config' && change !== 'disable-row')
                continue;
            const list = byRow.get(rowId) ?? [];
            list.push({ code: finding.code, change, risk: fix.risk ?? classifyRisk(fix.kind, fix.snippet) });
            byRow.set(rowId, list);
        }
    }
    const conflicts = [];
    for (const [rowId, fixes] of byRow) {
        if (fixes.length < 2)
            continue;
        // Same change twice is redundant, not contradictory: two findings may both
        // advise reconfiguring a row, and applying either achieves it.
        const changes = new Set(fixes.map((entry) => entry.change));
        if (changes.size < 2)
            continue;
        conflicts.push({ rowId, fixes });
    }
    return conflicts.sort((left, right) => (left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0));
}
