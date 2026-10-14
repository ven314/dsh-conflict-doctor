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
/** Which registry a piece of plugin code participates in. */
export type Realm = 'host' | 'client';
/** A package's declared browser half, as read from its manifest. */
export interface ClientHalfDeclaration {
    /** Declared platform string, e.g. `web`. Absent when not stated. */
    readonly platform?: string;
    /** Client module names the half requires. Order preserved, duplicates dropped. */
    readonly inject: readonly string[];
}
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
export declare function readClientHalf(manifest: Record<string, unknown> | undefined): ClientHalfDeclaration | undefined;
/**
 * The realm a package's plugin code runs in.
 *
 * @param clientHalf - the declaration, when the package has one.
 * @returns `client` when a browser half is declared, else `host`.
 */
export declare function realmOf(clientHalf: ClientHalfDeclaration | undefined): Realm;
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
export declare function comparableRealm(left: Realm, right: Realm): boolean;
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
export declare function moduleKey(name: string): string;
/** Every name a module may be referred to by, for provider-set membership. */
export declare function moduleAliases(name: string): string[];
