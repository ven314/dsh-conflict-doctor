import type { StaticSnapshot, VersionAuthority } from './types.js';
/** Recursively list `.js` files under `dir`, bounded by the scan caps. */
/**
 * Extract the tool ids a package declares in its compiled sources.
 *
 * Delegates to the shared source scanner so the same single pass also yields
 * imports and service names. Best-effort by construction: a tool built from a
 * non-literal name is invisible, which is why findings from this scan say
 * "declared in compiled sources" rather than "registered at runtime".
 *
 * @param dir - the package directory.
 * @returns distinct tool ids declared by that package.
 */
export declare function scanDeclaredToolIds(dir: string): string[];
/**
 * Read a profile directory and project its composition.
 *
 * @param profilePath - the profile directory (the one holding `package.json`
 *   with `dsh.profile.bundles` and `cordis.patch.yml`).
 * @param extraRoots - additional `node_modules` roots to search for packages.
 * @param liveBundleVersions - versions reported by the live plugin-manager,
 *   which take precedence over anything read from disk.
 * @param allowArchive - read the running host's OWN archive when no live
 *   versions were supplied. Set false for hermetic tests; default true.
 * @returns the static snapshot; missing files are reported as notes, never thrown.
 */
export declare function collectStatic(profilePath: string, extraRoots?: readonly string[], liveBundleVersions?: Readonly<Record<string, string>>, allowArchive?: boolean): StaticSnapshot;
/**
 * Compare the profile's on-disk core version against the running host's.
 *
 * Exported so the verdict can be unit-tested directly, and so callers can
 * explain it without re-deriving the rule.
 *
 * Four verdicts, and the fourth is why W1 exists. Historically there were three
 * and `stale-disk` meant "abstain": on a packaged desktop install the disk holds
 * one generation while the app runs another, so every version comparison was
 * suppressed — including the import check that catches a plugin calling an API
 * the host does not export. `archive-authoritative` replaces that abstention by
 * reading the running host's own archive and comparing against IT.
 *
 * @param diskHostVersion - `@deepseek-ai/dsh-base` version found on disk.
 * @param liveBundleVersions - versions reported by the live plugin-manager.
 * @param archiveVersions - versions read from the running host's archive.
 * @returns the verdict plus its explanation.
 */
export declare function resolveVersionAuthority(diskHostVersion: string | undefined, liveBundleVersions?: Readonly<Record<string, string>>, archiveVersions?: Readonly<Record<string, string>>): {
    verdict: VersionAuthority;
    reason?: string;
};
/**
 * Check whether an installed version satisfies a declared range.
 *
 * @param installed - the version installed in the profile tree.
 * @param range - the declared range; non-registry ranges are skipped.
 * @returns `undefined` when the range cannot be judged, else the verdict.
 */
export declare function satisfiesRange(installed: string | undefined, range: string): boolean | undefined;
