/**
 * Locate the DSH host that is ACTUALLY running, whether it ships inside an
 * Electron archive or sits unpacked in a node_modules tree.
 *
 * The problem this exists to solve: a packaged desktop app serves its profile
 * bundles from its own archive, while `profiles/node_modules` can hold an
 * entirely different generation. Reading versions and export surfaces from the
 * disk copies is how this project once invented seven conflicts that did not
 * exist. Every path in this module therefore leads back to the running process
 * first.
 *
 * Candidate order is deliberate — whatever the RUNNING binary points at wins,
 * and filesystem guesses come last:
 *
 *   1. $DSH_APP_ASAR          explicit override (tests, unusual installs)
 *   2. resources/app.asar     beside the running Electron binary
 *   3. resources/app/         unpacked Electron layout
 *   4. ../lib/node_modules    npm-style layout beside the running node
 *   5. $DSH_HOST_ROOT         explicit developer override
 *
 * @module dsh-conflict-doctor/hostroot
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
/** Candidate roots for bundled dependency trees inside one app tree. */
const MODULE_DIR_CANDIDATES = ['dsh/node_modules', 'node_modules', 'resources/app/node_modules', 'app/node_modules'];
/** True when `path` exists as a directory. */
function isDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** True when `path` exists as a file. */
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Resolve the bundled-dependency directory inside an unpacked app tree.
 *
 * @param root - the app root.
 * @returns the modules directory, or undefined when none exists.
 */
export function resolveModulesRoot(root) {
    for (const candidate of MODULE_DIR_CANDIDATES) {
        const dir = join(root, candidate);
        if (isDir(dir))
            return dir;
    }
    return undefined;
}
/**
 * Known install locations to try when the running process is NOT the app.
 *
 * Inside the packaged app `process.execPath` is the Electron binary, and the
 * archive sits right beside it — no searching required. This table exists for
 * the two cases where that is false: auditing from a plain Node process
 * (development, CI, `emit-report.mjs`) and layouts where the host lives under
 * the user directory rather than Program Files.
 *
 * Windows-first because that is where this project's false-positive has been
 * observed; the POSIX pair costs nothing.
 */
function knownInstallRoots() {
    const roots = [];
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (localAppData)
        roots.push(join(localAppData, 'Programs', 'DeepSeek Harness'));
    if (appData)
        roots.push(join(appData, 'Local', 'Programs', 'DeepSeek Harness'));
    if (home) {
        roots.push(join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness'));
        roots.push(join(home, '.deepseek-harness'));
        roots.push(join(home, '.dsh-host'));
        // macOS bundle layout, and the Linux unpacked equivalent.
        roots.push('/Applications/DeepSeek Harness.app/Contents/Resources');
        roots.push(join(home, '.local', 'share', 'deepseek-harness'));
    }
    const explicit = process.env.DSH_INSTALL_ROOT;
    if (explicit)
        roots.unshift(explicit);
    return roots;
}
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
export function findHostRoot() {
    const candidates = [];
    const explicitAsar = process.env.DSH_APP_ASAR;
    if (explicitAsar && isFile(explicitAsar)) {
        candidates.push({ root: dirname(explicitAsar), kind: 'asar', archive: explicitAsar, note: 'DSH_APP_ASAR override' });
    }
    // Whatever is actually running. This is the whole point: a desktop install
    // keeps its archive beside its own binary, and no other guess competes with
    // it. False when auditing from a plain Node process — the table below covers
    // that case.
    const resources = join(dirname(process.execPath), 'resources');
    const asar = join(resources, 'app.asar');
    if (isFile(asar)) {
        candidates.push({ root: resources, kind: 'asar', archive: asar, note: 'running Electron app.asar' });
    }
    const unpackedApp = join(resources, 'app');
    if (isDir(unpackedApp)) {
        candidates.push({ root: unpackedApp, kind: 'unpacked', note: 'running Electron app directory' });
    }
    const unpackedAsar = join(resources, 'app.asar.unpacked');
    if (isDir(unpackedAsar)) {
        candidates.push({ root: unpackedAsar, kind: 'unpacked', note: 'unpacked alongside the running app.asar' });
    }
    // Reachable from a plain Node process, where execPath is node itself.
    for (const root of knownInstallRoots()) {
        const candidateAsar = join(root, 'resources', 'app.asar');
        if (isFile(candidateAsar)) {
            candidates.push({ root: join(root, 'resources'), kind: 'asar', archive: candidateAsar, note: 'installed app.asar' });
            continue;
        }
        const looseAsar = join(root, 'app.asar');
        if (isFile(looseAsar)) {
            candidates.push({ root, kind: 'asar', archive: looseAsar, note: 'installed app.asar' });
            continue;
        }
        if (isDir(join(root, 'resources', 'app'))) {
            candidates.push({ root: join(root, 'resources', 'app'), kind: 'unpacked', note: 'installed unpacked app' });
            continue;
        }
        if (isDir(root)) {
            candidates.push({ root, kind: 'unpacked', note: 'known install root' });
        }
    }
    // npm-style: bundles live beside the interpreter, one level up.
    const libModules = join(dirname(process.execPath), '..', 'lib', 'node_modules');
    if (isDir(libModules)) {
        candidates.push({ root: libModules, kind: 'node-modules', note: 'node_modules beside the running interpreter' });
    }
    const explicitRoot = process.env.DSH_HOST_ROOT;
    if (explicitRoot && isDir(explicitRoot)) {
        candidates.push({ root: explicitRoot, kind: 'node-modules', note: 'DSH_HOST_ROOT override' });
    }
    /** Conditionally add a property only when value is not undefined. */
    function cond(obj, key, value) {
        return value !== undefined ? { ...obj, [key]: value } : obj;
    }
    for (const candidate of candidates) {
        // An `asar` root keeps dependencies inside the archive, so the modules root
        // is virtualised later by the caller; anything else must have them on disk.
        if (candidate.kind === 'asar') {
            const base = { path: candidate.root, kind: candidate.kind, modulesRoot: 'dsh/node_modules' };
            return cond(cond(base, 'archivePath', candidate.archive), 'note', candidate.note);
        }
        const modulesRoot = resolveModulesRoot(candidate.root);
        if (modulesRoot !== undefined) {
            return cond({ path: candidate.root, kind: candidate.kind, modulesRoot }, 'note', candidate.note);
        }
    }
    return undefined;
}
/**
 * Locate a host root, trying an explicit hint first.
 *
 * @param hint - a directory to prefer (usually the profile's own layout).
 * @returns the located root, falling back to {@link findHostRoot}.
 */
export function findHostRootStartingFrom(hint) {
    if (hint !== undefined && hint.length > 0) {
        const root = resolve(hint);
        if (isDir(root)) {
            const asar = join(root, 'resources', 'app.asar');
            if (isFile(asar)) {
                return {
                    path: join(root, 'resources'),
                    kind: 'asar',
                    archivePath: asar,
                    modulesRoot: 'dsh/node_modules',
                    note: 'archive beside the supplied root',
                };
            }
            const modulesRoot = resolveModulesRoot(root);
            if (modulesRoot !== undefined) {
                return { path: root, kind: 'node-modules', modulesRoot, note: 'supplied root' };
            }
        }
    }
    return findHostRoot();
}
/** Whether any host root exists at all (used to explain a skip). */
export function hostRootExists() {
    return existsSync(join(dirname(process.execPath), 'resources')) || process.env.DSH_HOST_ROOT !== undefined;
}
