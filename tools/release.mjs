// Sets the extension version, commits, tags v<version> and pushes both; the tag starts the release workflow.
// Usage: pnpm release <x.y.z>   (giving the current version skips the bump commit and only tags)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('usage: pnpm release <x.y.z>');
const tag = `v${version}`;

if (git('branch', '--show-current') !== 'main') fail('not on main');
if (git('status', '--porcelain')) fail('uncommitted changes; commit or stash them first');
git('fetch', '--quiet', '--tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in sync with origin/main');
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`);

// Only the top-level "version" line changes, so the files keep their formatting.
const FILES = ['apps/extension/package.json', 'apps/extension/static/manifest.json'];
let bumped = false;
for (const file of FILES) {
  const text = readFileSync(file, 'utf8');
  const current = JSON.parse(text).version;
  if (current === version) continue;
  const [major, minor, patch] = current.split('.').map(Number);
  const [nMajor, nMinor, nPatch] = version.split('.').map(Number);
  if (nMajor < major || (nMajor === major && (nMinor < minor || (nMinor === minor && nPatch < patch)))) {
    fail(`${version} is lower than ${current} in ${file}`);
  }
  writeFileSync(file, text.replace(/^(  "version": )"[^"]*"/m, `$1"${version}"`));
  bumped = true;
}

if (bumped) {
  git('add', ...FILES);
  git('commit', '--quiet', '-m', `release: ${version}`);
}
git('tag', '-a', tag, '-m', `onidoku ${version}`);
execFileSync('git', ['push', '--atomic', 'origin', 'main', tag], { stdio: 'inherit' });
console.log(`released ${tag}: the release workflow is building it on GitHub`);
