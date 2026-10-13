/**
 * One-command release for dsh-conflict-doctor.
 *
 * MAINTAINER TOOL — not shipped to users. `package.json` `files` lists only
 * `lib`, `cordis.patch.yml`, `README.md` and `LICENSE`, so this script never
 * reaches an installed profile.
 *
 *   node release.mjs           # publish to npm (requires `npm login`)
 *   node release.mjs --dry     # run every check, publish nothing
 *   node release.mjs --pr      # open the catalog PR (only after the repo is 1 day old)
 *   node release.mjs --all     # publish, then open the PR if the age gate allows
 *
 * The ordering is load-bearing and enforced:
 *
 *   npm publish  →  repo age >= 24h  →  catalog PR
 *
 * The catalog (awesome-dsh-plugin) rejects a repo younger than a day and its CI
 * verifies that the npm package resolves, so a PR opened earlier bounces.
 *
 * Credentials: the GitHub token comes from `git credential fill` — git's own
 * store, the same one `git push` uses — and is sent only to api.github.com. It
 * is never written to disk, never printed, and never forwarded anywhere else.
 * npm auth is npm's own; this script never handles it.
 *
 * Implementation notes worth keeping:
 * - `process.exit()` is deliberately avoided. Forcing exit while undici still
 *   holds async handles trips a libuv assertion on Windows
 *   (`!(handle->flags & UV_HANDLE_CLOSING)`), printing a crash-looking trace on
 *   an otherwise successful run. The code sets `process.exitCode` and returns.
 * - npm and pnpm are spawned through their JS entry points: on Windows they are
 *   .cmd/.ps1 shims that `execFileSync` cannot execute, and that failure carries
 *   no stdout or stderr to diagnose.
 *
 * @module dsh-conflict-doctor/release
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const PR = argv.includes('--pr') || argv.includes('--all')
const PUBLISH = !argv.includes('--pr') || argv.includes('--all')

const OWNER = 'ven314'
const REPO = 'dsh-conflict-doctor'
const CATALOG = 'awesome-dsh-plugin/awesome-dsh-plugin'
const CATALOG_REPO = CATALOG.split('/')[1]
const CATALOG_DEFAULT_BRANCH = 'main'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const ENTRY_NAME = `${OWNER}__${REPO}.yml`
const ENTRY_PATH = join(ROOT, 'catalog-entry.yml')

/**
 * Catalog entry body.
 *
 * `contributing.md` states that a description is read as a claim and checked
 * against the code, so every number here is verified by `test/run.mjs` and
 * `src/detect.ts` (17 distinct conflict checks). `description.en` must end with
 * a period and `zh` with a full stop; a `: ` inside a value requires quoting.
 */
const ENTRY_BODY = `url: https://github.com/${OWNER}/${REPO}
name: ${OWNER}/${REPO}
category: dev
description:
  en: "Conflict diagnosis and repair for DeepSeek Harness plugins. Builds a capability graph of the running Loader profile and of the on-disk cordis.patch.yml layers, then reports the conflicts that fail silently: a fiber stuck PENDING on a service no plugin provides, a tool id two plugins both register, duplicate Loader entry ids, a row disabled by one layer and re-inserted by another, and a plugin importing a host symbol the running host does not export. Every finding carries its evidence and the exact patch that fixes it."
  zh: "DSH 插件冲突诊断与修复建议。把运行期能力图谱与磁盘上的 cordis.patch.yml 层对齐，检出那些不会自己报错的静默故障：卡在 PENDING 等待无人提供的服务、两个插件注册同一个 tool id、Loader entry id 重复、某层停用又被后一层重新插入的行、以及插件导入了运行宿主并不导出的符号。每条结论都带证据与可直接粘贴的修复。"
`

const log = (...a) => console.log(...a)
const step = (title) => log(`\n=== ${title} ===`)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  return ok
}
const skip = (label, detail = '') => log(`  SKIP ${label}${detail ? `  ${detail}` : ''}`)

/** Run a command, returning trimmed stdout; throws a readable error otherwise. */
function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

/** Run a command whose failure is itself data. */
function probe(file, args, options = {}) {
  try {
    return { ok: true, out: run(file, args, options) }
  } catch (error) {
    return { ok: false, out: `${error.stderr ?? ''}${error.stdout ?? ''}${error.message}` }
  }
}

/** First existing path from a list of candidates. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/** Spawn pnpm without its Windows shim. */
function probePnpm(args) {
  const entry = firstExisting([
    process.env.npm_execpath && /pnpm/.test(process.env.npm_execpath) ? process.env.npm_execpath : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs') : undefined,
    join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ])
  return entry ? probe(process.execPath, [entry, ...args]) : probe('pnpm', args)
}

/** Spawn npm without its Windows shim. */
function probeNpm(args) {
  const entry = firstExisting([
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ])
  return entry ? probe(process.execPath, [entry, ...args]) : probe('npm', args)
}

/** Read the GitHub token from git's credential store. Never printed. */
function githubToken() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const line = out.split('\n').find((l) => l.startsWith('password='))
    return line ? line.slice('password='.length) : undefined
  } catch {
    return undefined
  }
}

/** One GitHub API call with the in-memory token. */
async function api(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-conflict-doctor-release',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  return { status: res.status, json }
}

/** Validate the catalog entry against the schema contributing.md documents. */
function validateEntry() {
  const CATEGORIES = [
    'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools',
    'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify',
    'dev', 'security', 'remote', 'market', 'fun',
  ]
  const problems = []
  const get = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(ENTRY_BODY)?.[1]
  if (get('url') !== `https://github.com/${OWNER}/${REPO}`) problems.push('url must match the repo exactly')
  if (get('name') !== `${OWNER}/${REPO}`) problems.push('name must be owner/repo')
  if (!CATEGORIES.includes(get('category'))) problems.push(`category must be one of the documented values (got ${get('category')})`)
  const en = /^\s{2}en:\s*"(.+)"\s*$/m.exec(ENTRY_BODY)?.[1]
  const zh = /^\s{2}zh:\s*"(.+)"\s*$/m.exec(ENTRY_BODY)?.[1]
  if (!en?.endsWith('.')) problems.push('description.en must end with a period')
  if (!zh?.endsWith('。')) problems.push('description.zh must end with a full stop')
  // A ':' followed by a space inside an unquoted scalar breaks YAML; both values are quoted.
  return { problems, en, zh }
}

async function main() {
  /* ---------------------------------------------------------------- preflight */

  step('1. preflight')
  log(`  package:    ${pkg.name}@${pkg.version}`)
  log(`  repo:       https://github.com/${OWNER}/${REPO}`)

  const whoami = probeNpm(['whoami'])
  const npmAuthed = whoami.ok && !/ENEEDAUTH|need auth/i.test(whoami.out)

  if (PUBLISH) {
    if (DRY && !npmAuthed) {
      skip('npm logged in', '(expected before `npm login`; --dry continues)')
    } else if (!check('npm logged in', npmAuthed, npmAuthed ? whoami.out : '→ run `npm login`')) {
      log('\n  npm publish needs your npm account, so this stops here.')
      log('  Run `npm login`, then re-run: node release.mjs')
      process.exitCode = 1
      return
    }
  } else {
    log(`  npm auth:   ${npmAuthed ? 'logged in' : 'not logged in (not needed for --pr)'}`)
  }

  const token = PR ? githubToken() : undefined
  if (PR) check('GitHub token from git credential store', Boolean(token))

  /* ------------------------------------------------------------------ verify */

  step('2. build, test, package')
  const build = probePnpm(['build'])
  check('build clean', build.ok && !/error TS/.test(build.out))

  const tests = probe(process.execPath, ['test/run.mjs'])
  const summary = /(\d+)\/(\d+) checks passed/.exec(tests.out)
  check('test suite green', Boolean(summary) && summary[1] === summary[2], summary ? `${summary[1]}/${summary[2]}` : 'no summary line')

  const meta = probe(process.execPath, ['test/check-metadata.mjs'])
  check('metadata checks green', meta.ok && !/FAIL/.test(meta.out))

  // Someone could take the name between runs.
  const view = probeNpm(['view', pkg.name, 'version'])
  const nameFree = !view.ok || /E404|not found/i.test(view.out)
  check('npm name still available', nameFree, nameFree ? pkg.name : view.out.split('\n')[0])

  // The catalog entry is a deliverable: validate it before it is ever submitted.
  writeFileSync(ENTRY_PATH, ENTRY_BODY)
  const { problems } = validateEntry()
  check('catalog entry valid', problems.length === 0, problems.join('; ') || ENTRY_PATH)

  if (failures > 0) {
    log(`\n  ${failures} check(s) failed — stopping.`)
    process.exitCode = 1
    return
  }

  /* ----------------------------------------------------------------- publish */

  if (PUBLISH) {
    step('3. npm publish')
    if (DRY) {
      // `npm publish --dry-run` still authenticates, so inspect the tarball
      // instead: --json reports the real file list without touching the registry.
      const packed = probeNpm(['pack', '--dry-run', '--json'])
      let files
      try {
        files = JSON.parse(packed.out)[0]?.files?.map((f) => f.path)
      } catch {
        files = undefined
      }
      check('tarball builds', packed.ok && Array.isArray(files) && files.length > 0, files ? `${files.length} files` : packed.out.slice(0, 160))
      for (const required of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'README.md', 'LICENSE']) {
        check(`tarball has ${required}`, Array.isArray(files) && files.includes(required))
      }
      log('  --dry: nothing published.')
    } else {
      const published = probeNpm(['publish', '--access', 'public'])
      if (check('published', published.ok, published.ok ? '' : published.out.slice(0, 300))) {
        const verify = probeNpm(['view', pkg.name, 'version'])
        check('registry resolves the new version', verify.ok && verify.out.includes(pkg.version), verify.out.split('\n')[0])
      }
    }
  }

  /* ------------------------------------------------------------- catalog PR */

  if (PR) {
    step('4. catalog PR')
    if (!token) {
      skip('catalog PR', '(no GitHub token)')
    } else {
      const info = await api(token, `/repos/${OWNER}/${REPO}`)
      if (info.status !== 200) {
        check('target repo readable', false, `HTTP ${info.status}`)
      } else {
        const createdAt = new Date(info.json.created_at)
        const ageHours = (Date.now() - createdAt.getTime()) / 3600000
        const oldEnough = ageHours >= 24

        check('repo is public', info.json.visibility === 'public', info.json.visibility)
        check('dsh-plugin topic present', (info.json.topics ?? []).includes('dsh-plugin'))

        if (!check('repo age >= 24h (catalog gate)', oldEnough, `${ageHours.toFixed(1)}h`)) {
          const when = new Date(createdAt.getTime() + 24 * 3600000)
          log(`\n  The catalog rejects repos younger than a day, so a PR now would bounce.`)
          log(`  Eligible after ${when.toISOString()}`)
          log(`  local time:   ${when.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
          log('  Then run:     node release.mjs --pr')
        } else if (failures === 0) {
          log('  forking the catalog…')
          await api(token, `/repos/${CATALOG}/forks`, { method: 'POST', body: '{}' })

          // The fork appears asynchronously; poll for its default branch.
          let baseSha
          for (let attempt = 0; attempt < 20 && !baseSha; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000))
            const ref = await api(token, `/repos/${OWNER}/${CATALOG_REPO}/git/ref/heads/${CATALOG_DEFAULT_BRANCH}`)
            baseSha = ref.json?.object?.sha
          }

          if (!check('fork ready', Boolean(baseSha))) {
            log('  fork was not ready in time — re-run: node release.mjs --pr')
          } else {
            const branch = `add-${REPO}`
            await api(token, `/repos/${OWNER}/${CATALOG_REPO}/git/refs`, {
              method: 'POST',
              body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
            })

            const put = await api(token, `/repos/${OWNER}/${CATALOG_REPO}/contents/data/plugins/${ENTRY_NAME}`, {
              method: 'PUT',
              body: JSON.stringify({
                message: `Add ${REPO}`,
                content: Buffer.from(ENTRY_BODY, 'utf8').toString('base64'),
                branch,
              }),
            })
            check('entry committed to the fork', put.status === 201, put.json?.content?.path ?? `HTTP ${put.status}`)

            const pr = await api(token, `/repos/${CATALOG}/pulls`, {
              method: 'POST',
              body: JSON.stringify({
                title: `Add ${REPO} (plugin conflict governance)`,
                head: `${OWNER}:${branch}`,
                base: CATALOG_DEFAULT_BRANCH,
                body: [
                  `Adds \`${REPO}\` — conflict diagnosis and repair for DeepSeek Harness plugins.`,
                  '',
                  `- npm: https://www.npmjs.com/package/${REPO}`,
                  `- repo: https://github.com/${OWNER}/${REPO}`,
                  '- license: MIT',
                  '',
                  'DSH tells you a plugin is *installed*; it does not tell you one is *not',
                  'working*. This plugin covers the silent cases: a fiber stuck PENDING on a',
                  'service nobody provides, a tool id two plugins both register, duplicate',
                  'Loader entry ids, a later patch layer replacing an earlier layer\u2019s config,',
                  'and a plugin importing a host symbol the running host does not export.',
                  '',
                  'Every finding carries its evidence and the exact `cordis.patch.yml` repair.',
                  'Version-comparison findings are suppressed when the running host version',
                  'cannot be confirmed, so the report never claims a conflict it cannot prove.',
                  '',
                  `Named \`${REPO}\` because \`dsh-plugin-doctor\` is an existing npm package by`,
                  'another author with a different scope (compatibility/security/install/rollback).',
                ].join('\n'),
              }),
            })
            check('PR opened', pr.status === 201, pr.json?.html_url ?? `HTTP ${pr.status}: ${JSON.stringify(pr.json).slice(0, 200)}`)
            if (pr.json?.html_url) log(`  ${pr.json.html_url}`)
          }
        }
      }
    }
  }

  /* ----------------------------------------------------------------- summary */

  step('5. state')
  log(`  npm:      ${PUBLISH ? (DRY ? '(dry run)' : `published ${pkg.name}@${pkg.version}`) : '(skipped)'}`)
  log(`  repo:     https://github.com/${OWNER}/${REPO}`)
  log(`  entry:    ${ENTRY_PATH}`)
  log(`  catalog:  ${PR ? 'see above' : 'not attempted — run: node release.mjs --pr'}`)
  log(`  install:  dsh plugin --profile web add ${pkg.name}`)

  if (failures > 0) {
    log(`\n  ${failures} check(s) failed.`)
    process.exitCode = 1
    return
  }
  log('\n  done.')
}

await main()
