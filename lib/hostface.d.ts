/**
 * Read the running host's bundled packages straight out of its Electron
 * archive, so symbol comparisons can be made against what ACTUALLY executes.
 *
 * A packaged desktop app serves its profile bundles from its own archive while
 * `profiles/node_modules` can hold an entirely different generation. Comparing
 * a plugin's imports against the disk copies is how this project once invented
 * seven conflicts that did not exist, so every read here resolves inside the
 * archive instead.
 *
 * The result is always optional: when no archive exists (a plain npm install,
 * CI, or an unpacked layout) these functions return undefined and the caller
 * falls back, rather than pretending to have evidence.
 *
 * @module dsh-conflict-doctor/hostface
 */
import { type AsarArchive } from './asar.js';
import { findHostRoot, resolveModulesRoot, type HostRoot } from './hostroot.js';
import { type ExportSurface } from './surface.js';
/** One bundle as the RUNNING host has it. */
export interface HostBundle {
    readonly name: string;
    readonly version: string;
    /** Directory inside the archive, slash-separated. */
    readonly dir: string;
    /** Free-text reason when the version could not be read. */
    readonly note?: string;
}
/** Everything learned about the running host in one read. */
export interface HostFacts {
    /** Where the host was found, for the report's coverage note. */
    readonly origin: string;
    /** Bundle name → version for every bundle the archive contains. */
    readonly bundles: ReadonlyMap<string, string>;
    /** True when every contributing read completed within budget. */
    readonly complete: boolean;
    /** Notes about anything skipped or unreadable. */
    readonly notes: readonly string[];
}
export declare function isSafePackageName(name: string): boolean;
/** Forget cached surfaces (used by tests and between audits). */
export declare function clearHostCaches(): void;
export declare function openHostArchive(): {
    archive: AsarArchive;
    root: HostRoot;
} | undefined;
/** Release the cached handle. Call when an audit finishes. */
export declare function closeHostArchive(): void;
/**
 * Read every bundled package version the running host ships.
 *
 * This is the authoritative replacement for reading versions off disk, and it
 * is what lets version-sensitive detectors stop abstaining.
 *
 * @returns the facts, or undefined when no host archive is available.
 */
export declare function collectHostFacts(): HostFacts | undefined;
/**
 * Read one package's export surface FROM THE RUNNING HOST.
 *
 * @param name - package name, e.g. `@deepseek-ai/dsh-tools`.
 * @returns the surface, or undefined when the package is not in this host.
 */
export declare function readHostSurface(name: string): ExportSurface | undefined;
/** Whether a bundle exists in the running host at all. */
export declare function hostHasBundle(name: string): boolean;
/** A host package's manifest, as the running host ships it. */
export interface HostManifest {
    readonly name: string;
    readonly version: string;
    /**
     * Subpaths the manifest's `exports` map allows, normalised to `./sub` form.
     *
     * `undefined` means the package declares NO `exports` map at all — which is
     * NOT the same as "no subpath is importable". Without `exports`, Node resolves
     * any path inside the package, so only a present-but-restrictive map can
     * justify claiming a subpath is denied.
     */
    readonly subpaths?: readonly string[];
    /** Whether the `exports` map contains a wildcard key such as `./src/*`. */
    readonly wildcard: boolean;
}
/**
 * Read one package's manifest FROM THE RUNNING HOST.
 *
 * @param name - package name.
 * @returns the manifest, or undefined when the package is not in this host.
 */
export declare function readHostManifest(name: string): HostManifest | undefined;
export { findHostRoot, resolveModulesRoot };
