import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walletCoreEntry = resolve(repoRoot, 'vendor/liberdus-wallet-core/index.js');
const walletCoreAdapter = resolve(repoRoot, 'vendor/liberdus-wallet-core/adapters/chain.js');

if (existsSync(walletCoreEntry) && existsSync(walletCoreAdapter)) {
  process.exit(0);
}

console.log('[wallet-core] Initializing vendor/liberdus-wallet-core submodule...');

const result = spawnSync(
  'git',
  ['submodule', 'update', '--init', '--recursive', 'vendor/liberdus-wallet-core'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error('[wallet-core] Unable to run git submodule update:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(walletCoreEntry) || !existsSync(walletCoreAdapter)) {
  console.error('[wallet-core] Submodule initialized, but required wallet core files are still missing.');
  process.exit(1);
}
