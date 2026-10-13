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
/**
 * Open the running host's archive.
 *
 * @returns the archive and its root, or undefined when there is nothing to open.
 */
export declare function openHostArchive(): {
    archive: AsarArchive;
    root: HostRoot;
} | undefined;
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
export { findHostRoot, resolveModulesRoot };
