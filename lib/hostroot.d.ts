/** How a host root was discovered, for the report's coverage note. */
export type HostRootKind = 'asar' | 'unpacked' | 'node-modules';
/** One located host root, with everything the surface reader needs. */
export interface HostRoot {
    /**
     * Root that contains either the asar file (kind `asar`) or the app tree.
     * For `asar` this is `resources/`; the archive path is {@link archivePath}.
     */
    readonly path: string;
    readonly kind: HostRootKind;
    /** Present and non-empty only when `kind === 'asar'`. */
    readonly archivePath?: string;
    /** Directory holding bundled dependencies inside this root. */
    readonly modulesRoot: string;
    /** Human note recorded when the choice involved a fallback. */
    readonly note?: string;
}
/**
 * Resolve the bundled-dependency directory inside an unpacked app tree.
 *
 * @param root - the app root.
 * @returns the modules directory, or undefined when none exists.
 */
export declare function resolveModulesRoot(root: string): string | undefined;
/**
 * Locate the running host's root.
 *
 * Never throws and never returns a root it cannot use: a candidate whose
 * bundled dependency tree is missing is skipped, because it cannot answer the
 * question either way.
 *
 * @returns the first usable host root, or undefined when none is usable. The
 *   caller turns `undefined` into a coverage note rather than guessing.
 */
export declare function findHostRoot(): HostRoot | undefined;
/**
 * Locate a host root, trying an explicit hint first.
 *
 * @param hint - a directory to prefer (usually the profile's own layout).
 * @returns the located root, falling back to {@link findHostRoot}.
 */
export declare function findHostRootStartingFrom(hint: string | undefined): HostRoot | undefined;
/** Whether any host root exists at all (used to explain a skip). */
export declare function hostRootExists(): boolean;
