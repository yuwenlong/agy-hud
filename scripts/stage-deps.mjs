#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDependencies } from '../runtime/pty-deps.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let targetDir = null;
  let bundled = false;
  let host = false;
  for (const arg of argv) {
    if (arg === '--bundled') {
      bundled = true;
    } else if (arg === '--host') {
      host = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!targetDir) {
      targetDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!targetDir || (bundled && host)) {
    throw new Error('Usage: node scripts/stage-deps.mjs <targetDir> [--bundled|--host]');
  }
  return { targetDir, hostOnly: !bundled };
}

try {
  const { targetDir, hostOnly } = parseArgs(process.argv.slice(2));
  const result = stageDependencies(repoRoot, path.resolve(targetDir), { hostOnly });
  process.stdout.write(`staged ${result.files.length} dependency file(s) (${hostOnly ? 'host' : 'bundled'}) into ${result.targetDir}\n`);
} catch (error) {
  process.stderr.write(`agy-hud stage-deps: ${error.message}\n`);
  process.exitCode = 1;
}
