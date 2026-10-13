/**
 * Collect a package's EXPORT SURFACE — the names a plugin is allowed to import
 * — reading from whichever medium actually holds the running host.
 *
 * This is what makes version-sensitive checks trustworthy on a packaged
 * desktop install. Reading `profiles/node_modules` compares a plugin against a
 * host that is not running, which is how this project once reported seven
 * missing symbols that were present after all.
 *
 * Sources, in order of trust:
 *
 *   1. a `.d.ts` entry — declares intent exactly, no ESM/CJS ambiguity;
 *   2. the `.js` entry listed by `exports`/`main` — for packages shipping no types;
 *   3. the directory union — last resort, flagged incomplete.
 *
 * The result is always an OVER-approximation: a name exported from ANY file in
 * the package counts. That bias is deliberate. A false "missing symbol" makes
 * the user chase a conflict that does not exist, while a missed detection only
 * costs coverage; for a diagnostics tool those errors are not symmetric.
 *
 * @module dsh-conflict-doctor/surface
 */
/** Whether every file contributing to the surface was read. */
export interface ExportSurface {
    /** Exported names found anywhere in the package. */
    readonly names: ReadonlySet<string>;
    /**
     * False when a budget cap truncated the walk. An incomplete surface may be
     * missing names, so it must never be used to claim a symbol is absent.
     */
    readonly complete: boolean;
    /** Files actually read — coverage evidence for the report. */
    readonly filesScanned: number;
    /** How the surface was obtained, for the report's coverage note. */
    readonly source: 'types' | 'js-entry' | 'directory-union';
    /** Entry file used, when one was resolved. */
    readonly entry?: string;
}
/** Caps that keep one pathological package from turning an audit into a hang. */
declare const DEFAULT_BUDGET: {
    /** Maximum files to read while following the import closure. */
    maxFiles: number;
    /** Maximum bytes per file; larger files are skipped, not truncated. */
    maxFileBytes: number;
    /** Maximum depth for following relative re-exports. */
    maxDepth: number;
};
export type SurfaceBudget = typeof DEFAULT_BUDGET;
/**
 * A readable slice of whichever store the host lives in.
 *
 * Both implementations resolve slash-separated relative paths within one
 * package directory, so the surface walker needs no knowledge of archives.
 */
export interface SurfaceSource {
    /** Read a file as UTF-8, or undefined when absent/unreadable. */
    readText(path: string): string | undefined;
    /** Whether a path exists as a file. */
    hasFile(path: string): boolean;
    /** Whether a path exists as a directory. */
    hasDir(path: string): boolean;
    /** Files immediately inside `dir` (names only). Optional. */
    listDir?(dir: string): readonly string[];
    /** Resolve a module specifier for this store, if supported. */
    resolveEntry?(pkgRoot: string, subpath: string): string | undefined;
}
/**
 * Collect one package's export surface.
 *
 * @param source - readable store for whichever medium holds the package.
 * @param pkgRoot - slash-separated root of the package.
 * @param manifest - parsed package.json (may be `{}` when unreadable).
 * @param overrides - optional budget caps.
 * @returns the surface plus how it was obtained.
 */
export declare function collectSurface(source: SurfaceSource, pkgRoot: string, manifest?: Record<string, unknown>, overrides?: Partial<SurfaceBudget>): ExportSurface;
export { DEFAULT_BUDGET };
