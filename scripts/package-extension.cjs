const { execFileSync } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = readJson(path.join(dist, 'manifest.json'));
const production = readJson(path.join(root, 'manifest.prod.json'));
const { version } = readJson(path.join(root, 'package.json'));

if (!isDeepStrictEqual(manifest, production) || manifest.version !== version) {
  throw new Error('Build the current production extension before packaging: npm run build:prod');
}

const archive = path.join(root, `vibeheader-${version}.zip`);
rmSync(archive, { force: true });
// Store uploads require manifest.json at the archive root.
execFileSync('zip', ['-q', '-X', '-r', archive, '.', '-x', '*.DS_Store'], {
  cwd: dist,
  stdio: 'inherit'
});
console.log(`Created ${path.basename(archive)}`);
