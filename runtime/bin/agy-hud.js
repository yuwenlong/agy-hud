#!/usr/bin/env node
if (process.argv[2] === 'launch') {
  const rawArgs = process.argv.slice(3);
  const launchArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const { launchAgy } = await import('../launch.mjs');
  const code = await launchAgy(launchArgs);
  if (typeof code === 'number') process.exitCode = code;
} else {
  const { main } = await import('../../hud.mjs');
  await main();
}
