/** What one package's compiled sources declare. */
export interface PackageSources {
    /** Tool ids declared via a literal `defineTool({ name: ... })`. */
    readonly tools: readonly string[];
    /** Host imports: module specifier → imported binding names. */
    readonly imports: Readonly<Record<string, readonly string[]>>;
    /** Service names the package appears to register. */
    readonly services: readonly string[];
    /** Files actually read (coverage evidence). */
    readonly filesScanned: number;
}
/** Recursively list `.js` files under `dir`, bounded by a shared budget. */
export declare function listJsFiles(dir: string, budget: {
    left: number;
}): string[];
/**
 * Extract the tool ids a package declares in its compiled sources.
 *
 * @param dir - the package directory.
 * @returns distinct tool ids, sorted.
 */
export declare function scanDeclaredToolIds(dir: string): string[];
/**
 * Extract every source-level fact this module knows how to read.
 *
 * @param dir - the package directory.
 * @returns the declared tools, host imports, and service names.
 */
export declare function scanPackageSources(dir: string): PackageSources;
/** Result of reading one installed package's export surface. */
export interface ExportSurface {
    /** Exported names found anywhere in the package's compiled sources. */
    readonly names: ReadonlySet<string>;
    /**
     * Whether the walk was exhaustive. When false the surface may be missing
     * names (budget exhausted), so it must not be used to claim something is
     * absent.
     */
    readonly complete: boolean;
}
/**
 * Collect the names a package exports from its compiled sources.
 *
 * Deliberately an OVER-approximation: a name exported from any file in the
 * package counts. `export * from` is therefore free rather than a false alarm —
 * the union of every file's exports is a superset of the real surface, so a
 * name missing from it is genuinely missing.
 *
 * @param dir - the package directory.
 * @returns the export surface plus its completeness flag.
 */
export declare function collectExportSurface(dir: string): ExportSurface;
/** Whether a directory looks like an installed package. */
export declare function isPackageDir(dir: string): boolean;
