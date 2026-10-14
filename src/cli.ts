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
 *                   [--out <file>]
 *
 * Exit codes: see EXIT in src/contract.ts —
 *   0 clean at the requested threshold, 1 warning (with --fail-on warning),
 *   2 critical (default threshold), 3 the audit could not run.
 *
 * @module dsh-conflict-doctor/cli
 */
import { writeFileSync } from 'node:fs'
import { EXIT, SCHEMA_VERSION, exitCodeFor, parseFailOn, type FailOn } from './contract.js'
import { detect } from './detect.js'
import { renderMarkdown } from './render.js'
import { collectStatic } from './static.js'
import { defaultProfilePath } from './index.js'
import type { AuditReport } from './types.js'

/** Parsed command-line options. */
interface CliOptions {
  scope: 'live' | 'profile' | 'all'
  format: 'markdown' | 'json'
  failOn: string | undefined
  profile: string | undefined
  out: string | undefined
  help?: boolean
}

/** Parse argv into options, refusing unknown flags rather than ignoring them. */
function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { scope: 'all', format: 'markdown', failOn: undefined, profile: undefined, out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    switch (arg) {
      case '--profile':
      case '-p':
        options.profile = next()
        break
      case '--scope': {
        const value = next()
        if (value !== 'live' && value !== 'profile' && value !== 'all') {
          throw new Error(`--scope must be live, profile, or all (got "${value}")`)
        }
        options.scope = value
        break
      }
      case '--format':
      case '-f': {
        const value = next()
        if (value !== 'markdown' && value !== 'json') {
          throw new Error(`--format must be markdown or json (got "${value}")`)
        }
        options.format = value
        break
      }
      case '--fail-on':
        options.failOn = next()
        break
      case '--out':
      case '-o':
        options.out = next()
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        // Silently ignoring a typo'd flag is how a CI gate ends up not running.
        throw new Error(`unknown argument "${arg}" (try --help)`)
    }
  }
  // Validation happens where each value is assigned, so the narrowing is real
  // rather than a cast the type checker cannot verify.
  return options
}

const HELP = `dsh-conflict-doctor — audit a DSH profile for plugin conflicts

  --profile, -p <dir>   profile directory (default: $DSH_PROFILE_DIR or the running profile)
  --scope <s>           live | profile | all   (default: all)
  --format, -f <fmt>    markdown | json        (default: markdown)
  --fail-on <level>     none | warning | critical (default: critical)
  --out, -o <file>      write the report here instead of stdout
  --help, -h            this text

Exit codes: 0 clean · 1 warning (with --fail-on warning) · 2 critical · 3 error`

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`conflict-doctor: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT.error
    return
  }
  if (options.help === true) {
    console.log(HELP)
    return
  }

  let failOn: FailOn
  try {
    failOn = parseFailOn(options.failOn)
  } catch (error) {
    console.error(`conflict-doctor: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT.error
    return
  }

  // Outside a harness there is no live context, so a live-only request cannot
  // be honoured. Say so instead of reporting a clean live scan that never ran.
  if (options.scope === 'live') {
    console.error(
      'conflict-doctor: --scope live needs a running harness; use the /conflict-doctor command or the conflict_doctor tool',
    )
    process.exitCode = EXIT.error
    return
  }

  const profilePath = options.profile ?? defaultProfilePath()
  if (profilePath === undefined) {
    console.error('conflict-doctor: no profile found; pass --profile, or set DSH_PROFILE_DIR')
    process.exitCode = EXIT.error
    return
  }

  let report: AuditReport
  try {
    // Built directly rather than through runAudit, which requires a Cordis
    // context for the live half. The shape is identical and validated by
    // schema/audit-report.schema.json.
    const snapshot = collectStatic(profilePath, [])
    const findings = detect({ profile: snapshot, nodeVersion: process.version })
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
    }
  } catch (error) {
    console.error(`conflict-doctor: the audit could not run: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT.error
    return
  }

  const rendered = options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`
  if (options.out !== undefined) {
    writeFileSync(options.out, rendered, 'utf8')
    console.error(`conflict-doctor: wrote ${options.out}`)
  } else {
    process.stdout.write(rendered)
  }

  const code = exitCodeFor(report.summary, failOn)
  if (code !== EXIT.ok) {
    console.error(`conflict-doctor: ${report.summary.critical} critical, ${report.summary.warning} warning (--fail-on ${failOn})`)
  }
  process.exitCode = code
}

await main()
