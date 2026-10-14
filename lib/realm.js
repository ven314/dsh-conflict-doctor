/**
 * Realm model: which half of the harness a package's plugin code runs in, and
 * which comparisons are therefore meaningful.
 *
 * The distinction is not cosmetic. A host package and a browser package can
 * legitimately register the same service name and the same tool id, because the
 * page runs in a different process with its own registries. Comparing them
 * produces conflicts that cannot happen — the mistake this module exists to
 * prevent, and the reason `profile/service-collision` already filters by realm.
 *
 * Concrete shapes come from the installed profile rather than from a spec: every
 * real `dsh.client` seen carries exactly `platform` and `inject`, where `inject`
 * lists CLIENT MODULE names such as `@deepseek-ai/dsh-client-ui-sidebar-right`.
 *
 * @module dsh-conflict-doctor/realm
 */
/**
 * Read a package's `dsh.client` declaration.
 *
 * Tolerant by design: manifests are third-party input, so a malformed shape
 * degrades to "declared, but with nothing readable" rather than throwing. That
 * distinction matters — a present-but-empty `dsh.client` still means the package
 * HAS a browser half, so its services and tool ids must not be compared against
 * host ones.
 *
 * @param manifest - the parsed package.json, or undefined when unreadable.
 * @returns the declaration when `dsh.client` is present, else undefined.
 */
export function readClientHalf(manifest) {
    const dsh = manifest?.dsh;
    if (dsh === null || typeof dsh !== 'object')
        return undefined;
    const client = dsh.client;
    if (client === undefined)
        return undefined;
    // `dsh.client` may be a bare string or boolean in hand-written manifests; the
    // presence is the fact, the contents are optional detail.
    if (client === null || typeof client !== 'object')
        return { inject: [] };
    const record = client;
    const platform = typeof record.platform === 'string' && record.platform.length > 0 ? record.platform : undefined;
    const rawInject = record.inject;
    // `inject` is a list in every real manifest, but an object form (name → opts)
    // is used elsewhere in cordis, so accept both and keep declaration order.
    let names = [];
    if (Array.isArray(rawInject)) {
        names = rawInject.filter((value) => typeof value === 'string' && value.length > 0);
    }
    else if (rawInject !== null && typeof rawInject === 'object') {
        names = Object.keys(rawInject);
    }
    const inject = [];
    const seen = new Set();
    for (const name of names) {
        if (seen.has(name))
            continue;
        seen.add(name);
        inject.push(name);
    }
    return { ...(platform === undefined ? {} : { platform }), inject };
}
/**
 * The realm a package's plugin code runs in.
 *
 * @param clientHalf - the declaration, when the package has one.
 * @returns `client` when a browser half is declared, else `host`.
 */
export function realmOf(clientHalf) {
    return clientHalf === undefined ? 'host' : 'client';
}
/**
 * Whether two realms may be compared at all.
 *
 * Only same-realm comparisons carry meaning: the page and the host have separate
 * service tables and separate tool registries, so a shared name across them is
 * not a conflict.
 *
 * @param left - first realm.
 * @param right - second realm.
 * @returns true when a name collision between them would be real.
 */
export function comparableRealm(left, right) {
    return left === right;
}
/**
 * Normalise a client module name for comparison.
 *
 * Module names in the wild differ by case and by whether they carry the
 * `@deepseek-ai/` scope. Treating `Dsh-Client-UI-Sidebar-Right` and
 * `@deepseek-ai/dsh-client-ui-sidebar-right` as different would report a missing
 * provider for a module that is present; treating them as equal is the safe
 * direction, because a false "missing" is the expensive error.
 *
 * @param name - the raw name as declared.
 * @returns a lower-cased, scope-stripped key for set membership.
 */
export function moduleKey(name) {
    const lower = name.toLowerCase();
    return lower.startsWith('@deepseek-ai/') ? lower.slice('@deepseek-ai/'.length) : lower;
}
/** Every name a module may be referred to by, for provider-set membership. */
export function moduleAliases(name) {
    const lower = name.toLowerCase();
    const bare = moduleKey(name);
    return lower === bare ? [bare] : [lower, bare];
}
