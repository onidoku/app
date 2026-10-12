// Builds release versions for Chrome (also accepted by Edge Add-ons) and Firefox, and zips each
// for its store. Refuses to package if anything dev-only made it into a build.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

const TARGETS = {
  chrome: { dir: 'dist', store: 'https://chrome.google.com/webstore/devconsole (also Edge Add-ons)' },
  firefox: { dir: 'dist-firefox', store: 'https://addons.mozilla.org/developers/' },
};

mkdirSync('release', { recursive: true });
for (const [target, { dir, store }] of Object.entries(TARGETS)) {
  run('node', ['build.mjs', `--target=${target}`]);

  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const problems = [];
  if (manifest.host_permissions?.length) problems.push(`manifest has host_permissions: ${manifest.host_permissions}`);
  if (manifest.name.includes('(dev)')) problems.push('manifest name says "(dev)"');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(`${dir}/${file}`, 'utf8');
    if (code.includes('testsite.')) problems.push(`${file} contains test-site configs`);
    if (code.includes('sourceMappingURL')) problems.push(`${file} contains a source map`);
  }
  if (problems.length) {
    console.error(`\nNot packaging ${target}:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  if (target === 'firefox') run('npx', ['web-ext', 'lint', '--source-dir', dir, '--self-hosted=false', '--warnings-as-errors']);

  const zip = `release/onidoku-${target}-${manifest.version}.zip`;
  rmSync(zip, { force: true });
  // Zip the folder's contents, not the folder: stores expect manifest.json at the root.
  run('zip', ['-qr', `../${zip}`, '.'], { cwd: dir });
  console.log(`Packaged ${zip}. Upload at ${store}\n`);
}

// AMO reviews the source of minified add-ons: it rebuilds from this zip with the README's steps
// (pnpm install && pnpm ext:package) and compares the result with the uploaded extension.
// Reviewers build from that zip, which has no .git: they only need the Firefox build above.
if (!existsSync('../../.git')) {
  console.log('Not a git checkout, so no source zip (it lists the files git tracks).');
  process.exit(0);
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const source = `apps/extension/release/onidoku-source-${version}.zip`;
rmSync(`../../${source}`, { force: true });
// Only what the repo would publish (tracked files plus new ones .gitignore allows), so ignored local files like
// examples/ never reach reviewers.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: '../..', encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(`../../${f}`));
run('zip', ['-q', source, '-@'], { cwd: '../..', input: files.join('\n'), stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`Packaged release/onidoku-source-${version}.zip. Upload it as the source code when AMO asks.`);
