#!/usr/bin/env node
/**
 * Command-line entry point: audit a profile without a running harness.
 *
 * The model-facing tool and the `/conflict-doctor` command cover the in-app
 * cases; this exists for the one case they cannot: CI. A pipeline needs a
 * process that exits non-zero on a real conflict, and a stable exit code for
 * each outcome, so a gate can fail without parsing prose.
 *
 * Usage:
 *   conflict-doctor [--profile <dir>] [--scope live|profile|all]
 *                   [--format markdown|json]
 *                   [--fail-on none|warning|critical]
 *                   [--dry-run]
 *                   [--out <file>]
 *
 * Exit codes: see EXIT in src/contract.ts —
 *   0 clean at the requested threshold, 1 warning (with --fail-on warning),
 *   2 critical (default threshold), 3 the audit could not run.
 *
 * @module dsh-conflict-doctor/cli
 */
import { writeFileSync } from 'node:fs';
import { rollbackFromBackup, writeFixFiles } from './apply.js';
import { EXIT, SCHEMA_VERSION, exitCodeFor, parseFailOn } from './contract.js';
import { detect } from './detect.js';
import { dryRunAll, renderDryRun } from './dryrun.js';
import { renderMarkdown } from './render.js';
import { collectStatic } from './static.js';
import { defaultProfilePath } from './index.js';
/**
 * Whether stdin is an interactive terminal.
 *
 * `--apply` asks for confirmation, and a confirmation prompt has nowhere to
 * go in a CI pipeline. The rule is therefore: an apply is only permitted
 * interactively, and a non-TTY caller must pass `--yes` to opt in. Detecting
 * this here, at the boundary, means the rule is one check rather than one
 * check per write site.
 */
export function isInteractive() {
    return process.stdin.isTTY === true;
}
/**
 * Whether a write operation may proceed.
 *
 * @param options - the parsed CLI options.
 * @returns a refusal message, or undefined when the write may proceed.
 */
export function confirmWrite(options) {
    if (options.yes === true)
        return undefined;
    return isInteractive() ? undefined : '非 TTY 环境下写入需要显式传入 --yes（CI 管道里没有地方可以确认）';
}
/** Parse argv into options, refusing unknown flags rather than ignoring them. */
function parseArgs(argv) {
    const options = { scope: 'all', format: 'markdown', failOn: undefined, profile: undefined, out: undefined };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--'))
                throw new Error(`${arg} needs a value`);
            i += 1;
            return value;
        };
        switch (arg) {
            case '--profile':
            case '-p':
                options.profile = next();
                break;
            case '--scope': {
                const value = next();
                if (value !== 'live' && value !== 'profile' && value !== 'all') {
                    throw new Error(`--scope must be live, profile, or all (got "${value}")`);
                }
                options.scope = value;
                break;
            }
            case '--format':
            case '-f': {
                const value = next();
                if (value !== 'markdown' && value !== 'json') {
                    throw new Error(`--format must be markdown or json (got "${value}")`);
                }
                options.format = value;
                break;
            }
            case '--fail-on':
                options.failOn = next();
                break;
            case '--out':
            case '-o':
                options.out = next();
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--fix-out':
                options.fixOut = next();
                break;
            case '--rollback':
                options.rollback = next();
                break;
            case '--yes':
                options.yes = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                // Silently ignoring a typo'd flag is how a CI gate ends up not running.
                throw new Error(`unknown argument "${arg}" (try --help)`);
        }
    }
    // Validation happens where each value is assigned, so the narrowing is real
    // rather than a cast the type checker cannot verify.
    return options;
}
const HELP = `dsh-conflict-doctor — audit a DSH profile for plugin conflicts

  --profile, -p <dir>   profile directory (default: $DSH_PROFILE_DIR or the running profile)
  --scope <s>           live | profile | all   (default: all)
  --format, -f <fmt>    markdown | json        (default: markdown)
  --fail-on <level>     none | warning | critical (default: critical)
  --dry-run             try every applicable repair in memory and report which
                        ones actually resolve their finding (writes nothing)
  --fix-out <dir>       write each applicable repair as its own .patch.yml plus a
                        README, for manual review (never touches the profile)
  --out, -o <file>      write the report here instead of stdout
  --help, -h            this text

Exit codes: 0 clean · 1 warning (with --fail-on warning) · 2 critical · 3 error`;
async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    }
    catch (error) {
        console.error(`conflict-doctor: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = EXIT.error;
        return;
    }
    if (options.help === true) {
        console.log(HELP);
        return;
    }
    let failOn;
    try {
        failOn = parseFailOn(options.failOn);
    }
    catch (error) {
        console.error(`conflict-doctor: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = EXIT.error;
        return;
    }
    // Outside a harness there is no live context, so a live-only request cannot
    // be honoured. Say so instead of reporting a clean live scan that never ran.
    if (options.scope === 'live') {
        console.error('conflict-doctor: --scope live needs a running harness; use the /conflict-doctor command or the conflict_doctor tool');
        process.exitCode = EXIT.error;
        return;
    }
    const profilePath = options.profile ?? defaultProfilePath();
    if (profilePath === undefined) {
        console.error('conflict-doctor: no profile found; pass --profile, or set DSH_PROFILE_DIR');
        process.exitCode = EXIT.error;
        return;
    }
    // `--rollback` is a standalone operation: it restores one file from a backup
    // and re-audits to confirm the profile is back where it was. It needs no
    // audit of its own to run, and it must not be combined with a normal audit.
    if (options.rollback !== undefined) {
        try {
            const outcome = rollbackFromBackup(profilePath, options.rollback);
            if (!outcome.ok) {
                console.error(`conflict-doctor: --rollback refused: ${outcome.reason}`);
                process.exitCode = EXIT.error;
                return;
            }
            console.error(`conflict-doctor: rolled back ${outcome.targetPath} from ${outcome.backupPath} (${outcome.bytes} bytes)`);
            // Re-audit to confirm the profile is back where it was, so the user can
            // see the same findings they had before the change.
            const snapshot = collectStatic(profilePath, []);
            const findings = detect({ profile: snapshot, nodeVersion: process.version });
            const critical = findings.filter((f) => f.severity === 'critical').length;
            const warning = findings.filter((f) => f.severity === 'warning').length;
            console.error(`conflict-doctor: re-audit after rollback: ${findings.length} findings (${critical} critical, ${warning} warning)`);
            process.exitCode = exitCodeFor({ critical, warning }, failOn);
            return;
        }
        catch (error) {
            console.error(`conflict-doctor: --rollback failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = EXIT.error;
            return;
        }
    }
    let report;
    try {
        // Built directly rather than through runAudit, which requires a Cordis
        // context for the live half. The shape is identical and validated by
        // schema/audit-report.schema.json.
        const snapshot = collectStatic(profilePath, []);
        const findings = detect({ profile: snapshot, nodeVersion: process.version });
        report = {
            schemaVersion: SCHEMA_VERSION,
            generatedAt: new Date().toISOString(),
            profilePath,
            scope: 'profile',
            summary: {
                critical: findings.filter((f) => f.severity === 'critical').length,
                warning: findings.filter((f) => f.severity === 'warning').length,
                info: findings.filter((f) => f.severity === 'info').length,
                liveEntries: 0,
                patchLayers: snapshot.layers.length,
                scannedPackages: snapshot.packages.length,
                declaredTools: Object.keys(snapshot.declaredTools).length,
            },
            findings,
            notes: snapshot.notes,
            versionAuthority: snapshot.versionAuthority,
        };
    }
    catch (error) {
        console.error(`conflict-doctor: the audit could not run: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = EXIT.error;
        return;
    }
    const rendered = options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`;
    if (options.out !== undefined) {
        writeFileSync(options.out, rendered, 'utf8');
        console.error(`conflict-doctor: wrote ${options.out}`);
    }
    else {
        process.stdout.write(rendered);
    }
    if (options.dryRun === true) {
        // Reported SEPARATELY from the audit, never merged into it. The JSON
        // contract is frozen and machine-read, so mixing a simulation into it would
        // break consumers; and a dry run is a statement about the repairs, not about
        // the profile. For `--format json` results go to stderr so stdout stays a
        // single parseable document.
        let outcomes;
        try {
            outcomes = dryRunAll(profilePath, report.findings, { nodeVersion: process.version });
        }
        catch (error) {
            console.error(`conflict-doctor: --dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = EXIT.error;
            return;
        }
        const lines = [
            '',
            '## 修复试跑（--dry-run，未写入任何文件）',
            '',
            '每条可应用的修复都在**内存里**套用后重跑了审计。未解决不代表修复有错：',
            '有些结论描述的是设计上就存在的状态（例如多层重述），其建议是让最后一层权威，而非消除结论本身。',
            '',
            renderDryRun(outcomes),
            '',
            `可应用修复 ${outcomes.length} 条 · 已解决 ${outcomes.filter((o) => o.resolved).length} 条 · ` +
                `引入新结论 ${outcomes.filter((o) => o.introduced.length > 0).length} 条`,
            '',
        ].join('\n');
        if (options.format === 'json')
            process.stderr.write(lines);
        else
            process.stdout.write(lines);
    }
    if (options.fixOut !== undefined) {
        // Explicit, non-destructive output: real files a user can read and pick
        // from. Nothing in the profile is touched, and a stray `.patch.yml` beside
        // `cordis.patch.yml` is inert, so a wrong pick cannot break anything.
        try {
            const files = writeFixFiles(options.fixOut, report.findings);
            console.error(`conflict-doctor: wrote ${files.length} repair file(s) to ${options.fixOut}`);
            if (files.length === 0)
                console.error('conflict-doctor: none of the findings had an applicable patch fragment');
        }
        catch (error) {
            console.error(`conflict-doctor: --fix-out failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = EXIT.error;
            return;
        }
    }
    const code = exitCodeFor(report.summary, failOn);
    if (code !== EXIT.ok) {
        console.error(`conflict-doctor: ${report.summary.critical} critical, ${report.summary.warning} warning (--fail-on ${failOn})`);
    }
    process.exitCode = code;
}
await main();
