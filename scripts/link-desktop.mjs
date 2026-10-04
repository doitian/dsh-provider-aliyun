#!/usr/bin/env node
/**
 * Point the desktop DSH profile at this checkout, so the app loads this build.
 *
 * A `file:` dependency is *not* a live view of the worktree: pnpm hard-links the
 * files in, and a plain `install`, `--force`, or `update` will not re-link them
 * even after they change — it reports "Already up to date". Re-adding the
 * dependency is what forces a fresh resolution, which is all this script does:
 *
 *   npm run link:desktop
 *
 * Then restart DSH: plugin modules are loaded once at startup and the loader
 * does not watch them. Re-run this after every change you want the app to see,
 * and check the verification output it prints — a mismatch means the app is
 * still on the previous build.
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

if (!existsSync(profileManifest)) {
  console.error(`link-desktop: no profile at ${profile}, so there is nothing to link into`)
  process.exit(1)
}
if (!existsSync(pnpm)) {
  console.error(`link-desktop: the bundled pnpm is not at ${pnpm}; set DSH_HOME or install the harness first`)
  process.exit(1)
}

const spec = `${manifest.name}@file:${root.replace(/\\/g, '/')}`
console.log(`link-desktop: ${profileName} profile -> ${root}`)
const install = spawnSync(process.execPath, [pnpm, '--dir', profile, 'add', spec], { stdio: 'inherit' })
if (install.status !== 0) {
  console.error('link-desktop: pnpm refused the dependency; the profile still points where it did before')
  process.exit(install.status ?? 1)
}

/** Every published file, as the tarball would carry it. */
const published = (manifest.files ?? []).filter((entry) => entry.endsWith('.js') || entry.endsWith('.json'))
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const stale = []
for (const relative of published) {
  const source = join(root, relative)
  const target = join(installed, relative)
  if (!existsSync(source)) continue
  if (!existsSync(target) || digest(source) !== digest(target)) stale.push(relative)
}

const libCount = existsSync(join(installed, 'lib')) ? readdirSync(join(installed, 'lib')).length : 0
console.log(`link-desktop: ${libCount} files in the installed lib/, ${published.length} checked`)
if (stale.length > 0) {
  console.error(`link-desktop: the installed copy does not match this checkout: ${stale.join(', ')}`)
  process.exit(1)
}
console.log('link-desktop: installed copy matches this checkout byte for byte')
console.log('link-desktop: restart DSH to load it — the loader does not watch plugin files')
