/**
 * Source-level facts about an installed plugin package, extracted from its
 * compiled JavaScript in ONE pass.
 *
 * Three questions, three signals:
 * - which tool ids does it declare (`defineTool({ name: '...' })`);
 * - which host symbols does it import (`import { x } from '@deepseek-ai/dsh-y'`);
 * - which service names does it register (`super(ctx, '...')`).
 *
 * All three are over-approximations by construction: a name built at runtime is
 * invisible, so a finding is always phrased as "declared in compiled sources".
 * The bias is deliberate — for a diagnostics tool, a missed detection costs
 * less than a false alarm.
 * @module dsh-conflict-doctor/source
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** Caps that keep a pathological package tree from turning an audit into a hang. */
const MAX_FILES_SCANNED = 400;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const DEFINE_TOOL_WINDOW = 1200;
const MAX_EXPORT_FILES = 80;
/** Recursively list `.js` files under `dir`, bounded by a shared budget. */
export function listJsFiles(dir, budget) {
    const out = [];
    if (budget.left <= 0)
        return out;
    let stat;
    try {
        stat = statSync(dir);
    }
    catch {
        return out;
    }
    if (!stat.isDirectory())
        return out;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (budget.left <= 0)
            break;
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listJsFiles(child, budget));
        }
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            budget.left -= 1;
            out.push(child);
        }
    }
    return out;
}
/** Read a text file without throwing. */
function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
}
/** Read a `.js` file only when it is inside the size cap. */
function readBounded(file) {
    try {
        if (statSync(file).size > MAX_FILE_BYTES)
            return undefined;
    }
    catch {
        return undefined;
    }
    return readText(file);
}
/**
 * Extract the tool ids a package declares in its compiled sources.
 *
 * @param dir - the package directory.
 * @returns distinct tool ids, sorted.
 */
export function scanDeclaredToolIds(dir) {
    return [...scanPackageSources(dir).tools];
}
/**
 * Extract every source-level fact this module knows how to read.
 *
 * @param dir - the package directory.
 * @returns the declared tools, host imports, and service names.
 */
export function scanPackageSources(dir) {
    const files = listJsFiles(join(dir, 'lib'), { left: MAX_FILES_SCANNED });
    const tools = new Set();
    const services = new Set();
    const imports = new Map();
    let filesScanned = 0;
    for (const file of files) {
        const text = readBounded(file);
        if (text === undefined)
            continue;
        filesScanned += 1;
        // Tool ids: the first `name:` string inside each defineTool({ ... }) window.
        let from = text.indexOf('defineTool(');
        while (from !== -1) {
            const window = text.slice(from, from + DEFINE_TOOL_WINDOW);
            const match = /name:\s*['"]([A-Za-z_][A-Za-z0-9_-]{1,63})['"]/.exec(window);
            if (match?.[1] !== undefined)
                tools.add(match[1]);
            from = text.indexOf('defineTool(', from + 1);
        }
        // Service names: the two registration idioms in this codebase.
        for (const pattern of [
            /super\(\s*[\w.$]+\s*,\s*['"]([A-Za-z_][\w.-]{1,63})['"]/g,
            /\bprovide\(\s*['"]([A-Za-z_][\w.-]{1,63})['"]/g,
            /\bprovide:\s*['"]([A-Za-z_][\w.-]{1,63})['"]/g,
        ]) {
            let hit = pattern.exec(text);
            while (hit !== null) {
                if (hit[1] !== undefined)
                    services.add(hit[1]);
                hit = pattern.exec(text);
            }
        }
        // Host imports: named bindings only (a default import carries no name to verify).
        const importPattern = /\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
        let imported = importPattern.exec(text);
        while (imported !== null) {
            const specifier = imported[2];
            const names = imported[1];
            if (specifier?.startsWith('@deepseek-ai/') && names !== undefined) {
                const bucket = imports.get(specifier) ?? new Set();
                for (const raw of names.split(',')) {
                    const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
                    if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name))
                        bucket.add(name);
                }
                if (bucket.size > 0)
                    imports.set(specifier, bucket);
            }
            imported = importPattern.exec(text);
        }
    }
    return {
        tools: [...tools].sort(),
        services: [...services].sort(),
        imports: Object.fromEntries([...imports].map(([module, names]) => [module, [...names].sort()])),
        filesScanned,
    };
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
export function collectExportSurface(dir) {
    const files = listJsFiles(join(dir, 'lib'), { left: MAX_EXPORT_FILES });
    const budget = { left: MAX_EXPORT_FILES };
    const names = new Set();
    let complete = budget.left > 0;
    for (const file of files) {
        const text = readBounded(file);
        if (text === undefined)
            continue;
        for (const pattern of [
            /\bexport\s*\{([^}]*)\}/g,
            /\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
            /\bexport\s+default\b/g,
        ]) {
            let hit = pattern.exec(text);
            while (hit !== null) {
                const group = hit[1];
                if (group === undefined) {
                    names.add('default');
                }
                else {
                    // Parse each entry INDEPENDENTLY. A list mixing plain and aliased
                    // names (`export { A, B as default, C }`) must contribute all three;
                    // treating the whole list as aliases-only silently drops A and C.
                    for (const part of group.split(',')) {
                        const segments = part.trim().split(/\s+as\s+/);
                        const exported = (segments.length > 1 ? segments[1] : segments[0])?.trim();
                        if (exported !== undefined && exported.length > 0 && /^[A-Za-z_$][\w$]*$/.test(exported)) {
                            names.add(exported);
                        }
                    }
                }
                hit = pattern.exec(text);
            }
        }
    }
    return { names, complete };
}
/** Whether a directory looks like an installed package. */
export function isPackageDir(dir) {
    return existsSync(join(dir, 'package.json'));
}
