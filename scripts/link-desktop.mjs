#!/usr/bin/env node
/**
 * Point the desktop DSH profile at this checkout, so the app loads this build.
 *
 * A `file:` dependency is *not* a live view of the worktree: pnpm hard-links the
 * files in, and a plain `install`, `--force`, or `update` will not re-link them
 * even after they change — it reports "Already up to date". Re-adding the
 * dependency is what forces a fresh resolution.
 *
 * `add` alone is not always enough, though: pnpm treats a spec that already
 * resolves as up to date, so a file that was *replaced* — by an atomic editor
 * save, or by `git checkout` — keeps its previous bytes in the profile. When the
 * check below finds that, the script drops the dependency and resolves it again
 * rather than printing a mismatch for you to work around.
 *
 *   npm run link:desktop
 *
 * Then restart DSH: plugin modules are loaded once at startup and the loader
 * does not watch them. Re-run this after every change you want the app to see,
 * and read the verification output it prints — a mismatch means the app is still
 * on the previous build.
 *
 * The daemon-managed Plugins page may rewrite the dependency back to a registry
 * range; that is a normal package install, and this script switches it back.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE ?? 'desktop'
const profile = join(dshHome, 'profiles', profileName)
const profileManifest = join(profile, 'package.json')
const pnpm = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
const installed = join(profile, 'node_modules', ...manifest.name.split('/'))
const spec = `${manifest.name}@file:${root.replace(/\\/g, '/')}`
/** Every published file, as the tarball would carry it. */
const published = (manifest.files ?? []).filter((entry) => entry.endsWith('.js') || entry.endsWith('.json'))

if (!existsSync(profileManifest)) {
  console.error(`link-desktop: no profile at ${profile}, so there is nothing to link into`)
  process.exit(1)
}
if (!existsSync(pnpm)) {
  console.error(`link-desktop: the bundled pnpm is not at ${pnpm}; set DSH_HOME or install the harness first`)
  process.exit(1)
}

/**
 * Run one pnpm subcommand in the profile directory.
 * @param {string[]} args - arguments after the pnpm script path.
 * @returns {number} the exit status.
 */
function runPnpm(args) {
  return spawnSync(process.execPath, [pnpm, '--dir', profile, ...args], { stdio: 'inherit' }).status ?? 1
}

/**
 * Compare every published file against the installed copy.
 * @returns {string[]} the relative paths that differ or are missing.
 */
function staleAgainstCheckout() {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const stale = []
  for (const relative of published) {
    const source = join(root, relative)
    const target = join(installed, relative)
    if (!existsSync(source)) continue
    if (!existsSync(target) || digest(source) !== digest(target)) stale.push(relative)
  }
  return stale
}

console.log(`link-desktop: ${profileName} profile -> ${root}`)
if (runPnpm(['add', spec]) !== 0) {
  console.error('link-desktop: pnpm refused the dependency; the profile still points where it did before')
  process.exit(1)
}

let stale = staleAgainstCheckout()
if (stale.length > 0) {
  // The dependency already resolved, so pnpm had nothing to do and left the
  // previous bytes in place. Dropping it first is what makes the next resolution
  // read the directory again instead of trusting the spec it already recorded.
  console.log(`link-desktop: the installed copy is stale (${stale.join(', ')}); re-resolving from scratch`)
  if (runPnpm(['remove', manifest.name]) !== 0) {
    console.error(`link-desktop: pnpm refused to drop the dependency. Restore it by hand — pnpm --dir "${profile}" add "${spec}" — then re-run this script`)
    process.exit(1)
  }
  if (runPnpm(['add', spec]) !== 0) {
    console.error('link-desktop: pnpm refused to re-add the dependency, so the profile no longer has it; re-run this script once pnpm recovers')
    process.exit(1)
  }
  stale = staleAgainstCheckout()
}

const libCount = existsSync(join(installed, 'lib')) ? readdirSync(join(installed, 'lib')).length : 0
console.log(`link-desktop: ${libCount} files in the installed lib/, ${published.length} checked`)
if (stale.length > 0) {
  console.error(`link-desktop: the installed copy does not match this checkout: ${stale.join(', ')}`)
  process.exit(1)
}
console.log('link-desktop: installed copy matches this checkout byte for byte')
console.log('link-desktop: restart DSH to load it — the loader does not watch plugin files')
