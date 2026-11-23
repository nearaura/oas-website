import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const hasTinaCloudCredentials = Boolean(
	process.env.NEXT_PUBLIC_TINA_CLIENT_ID && process.env.TINA_TOKEN,
);

const tinaArgs = ['exec', 'tinacms', 'build', '--skip-indexing'];
if (!hasTinaCloudCredentials) tinaArgs.push('--skip-cloud-checks');

process.env.TINA_BUILD_STATIC = '1';

function run(args) {
	const result = spawnSync(packageManager, args, {
		stdio: 'inherit',
		shell: process.platform === 'win32',
		env: { ...process.env, NODE_ENV: 'production' },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run(tinaArgs);

// Tina's generated admin page shows the asset-load error after only 2 seconds.
// The admin JS bundle is several MB, so slow connections (e.g. 3 Mbps) trip
// this check even though the assets are still downloading.
const adminIndexPath = fileURLToPath(
	new URL('../public/admin/index.html', import.meta.url),
);
const adminIndex = readFileSync(adminIndexPath, 'utf8');
const assetTimeout = '}, 2000)';
if (!adminIndex.includes(assetTimeout)) {
	throw new Error('Tina admin asset timeout marker was not found');
}
writeFileSync(
	adminIndexPath,
	adminIndex.replace(assetTimeout, '}, 30000)'),
);

run(['exec', 'astro', 'build']);
