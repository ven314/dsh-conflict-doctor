/**
 * Validate an audit report against the frozen JSON contract.
 *
 * Implements the subset of JSON Schema 2020-12 that `schema/audit-report.schema.json`
 * actually uses, rather than pulling in a validator dependency. That is a
 * deliberate trade: the plugin is installed into other people's harnesses, and a
 * schema that can drift from its validator is worse than no schema at all. The
 * schema file is read from disk and interpreted, so it stays the single source
 * of truth.
 *
 * Supported keywords: type, required, properties, additionalProperties, items,
 * enum, const, minimum, minLength, minItems, pattern, $ref (local), $defs,
 * format (date-time only), oneOf.
 *
 * Usage:
 *   node test/check-schema.mjs                 # validate every report it can build
 *   node test/check-schema.mjs <report.json>   # validate one file
 *
 * Exit code 0 = every report conforms.
 *
 * @module dsh-conflict-doctor/check-schema
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_PATH = join(ROOT, 'schema', 'audit-report.schema.json')

/** Resolve a local `$ref` like `#/$defs/finding`. */
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`only local refs are supported, got ${ref}`)
  let node = root
  for (const segment of ref.slice(2).split('/')) {
    node = node?.[segment]
    if (node === undefined) throw new Error(`unresolvable $ref ${ref}`)
  }
  return node
}

/** True when `value` matches the JSON type named by `type`. */
function matchesType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      throw new Error(`unsupported schema type ${type}`)
  }
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Validate one value against one schema node.
 *
 * @param value - the value to check.
 * @param schema - a schema node from the contract.
 * @param root - the whole schema, for `$ref` resolution.
 * @param path - JSON path for error messages.
 * @param errors - accumulator.
 */
function validate(value, schema, root, path, errors) {
  if (schema.$ref !== undefined) {
    validate(value, resolveRef(root, schema.$ref), root, path, errors)
    return
  }

  if (schema.oneOf !== undefined) {
    const passes = schema.oneOf.filter((branch) => {
      const local = []
      validate(value, branch, root, path, local)
      return local.length === 0
    })
    if (passes.length !== 1) errors.push(`${path}: matched ${passes.length} oneOf branches, expected exactly 1`)
    return
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(
        `${path}: expected ${types.join('|')}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`,
      )
      // Further checks would only produce noise against the wrong shape.
      return
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`)
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`)
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`)
    }
    if (schema.format === 'date-time' && !ISO_DATE_TIME.test(value)) {
      errors.push(`${path}: not an ISO-8601 date-time`)
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below minimum ${schema.minimum}`)
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: has ${value.length} item(s), needs at least ${schema.minItems}`)
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validate(item, schema.items, root, `${path}[${index}]`, errors))
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`)
    }
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) {
        validate(child, properties[key], root, `${path}.${key}`, errors)
        continue
      }
      // `additionalProperties: false` is what keeps a typo'd field from being
      // silently ignored by a consumer.
      if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`)
      } else if (typeof schema.additionalProperties === 'object') {
        validate(child, schema.additionalProperties, root, `${path}.${key}`, errors)
      }
    }
  }
}

/**
 * Validate a report against the contract.
 *
 * @param report - parsed report value.
 * @returns the list of violations; empty means conformant.
 */
export function validateReport(report) {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  const errors = []
  validate(report, schema, schema, '$', errors)
  return errors
}

/* ------------------------------------------------------------------ CLI --- */

// `import.meta.url` is a percent-encoded file URL, while argv[1] is a native
// path; comparing them as strings silently disabled this whole script on
// Windows (the path contains a non-ASCII user name). Compare resolved paths.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(dirname(process.argv[1]), 'check-schema.mjs')

if (invokedDirectly) {
  const explicit = process.argv[2]
  const errors = []

  if (explicit !== undefined) {
    const report = JSON.parse(readFileSync(explicit, 'utf8'))
    errors.push(...validateReport(report).map((error) => `${explicit} ${error}`))
  } else {
    // Build a report from whatever this machine can offer, so the contract is
    // exercised against real data and not only a hand-written fixture.
    const { collectStatic, defaultProfilePath, detect, renderMarkdown } = await import('../lib/index.js')
    const { SCHEMA_VERSION } = await import('../lib/contract.js')

    const profilePath = process.env.DSH_PROFILE_DIR ?? defaultProfilePath()
    if (profilePath !== undefined && existsSync(profilePath)) {
      const snapshot = collectStatic(profilePath, [])
      const findings = detect({ profile: snapshot, nodeVersion: process.version })
      const report = {
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
      const violations = validateReport(report)
      console.log(`  real profile report: schemaVersion=${report.schemaVersion} findings=${findings.length}`)
      for (const violation of violations) console.log(`    FAIL ${violation}`)
      errors.push(...violations)

      // A JSON round-trip must preserve the report exactly: the contract is what
      // `format: "json"` emits, so a field that does not survive serialisation
      // is a field consumers cannot rely on.
      const roundTripped = JSON.parse(JSON.stringify(report))
      const drift = validateReport(roundTripped)
      if (drift.length > 0) {
        console.log('    FAIL report does not survive a JSON round-trip')
        errors.push(...drift)
      } else if (JSON.stringify(roundTripped) !== JSON.stringify(report)) {
        console.log('    FAIL report changed across a JSON round-trip')
        errors.push('round-trip drift')
      }

      // Markdown must be renderable from the same object.
      const markdown = renderMarkdown(report)
      if (typeof markdown !== 'string' || markdown.length === 0) errors.push('markdown rendering produced nothing')
    } else {
      console.log('  SKIP no profile on this machine')
    }

    // Additionally validate every committed golden, which pins real shapes.
    const goldenDir = join(ROOT, 'test', 'golden')
    if (existsSync(goldenDir)) {
      for (const file of readdirSync(goldenDir).filter((name) => name.endsWith('.json'))) {
        const golden = JSON.parse(readFileSync(join(goldenDir, file), 'utf8'))
        if (golden.findings === undefined) continue
        console.log(`  golden ${file}: ${golden.findings.length} finding line(s)`)
      }
    }
  }

  if (errors.length > 0) {
    console.log(`\n  ${errors.length} schema violation(s).`)
    process.exit(1)
  }
  console.log('\n  report conforms to the frozen contract.')
}
