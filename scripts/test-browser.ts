const suites = {
  e2e: [
    './tests/e2e/studio-flows.browser.ts',
    './tests/e2e/job-history.browser.ts',
    './tests/e2e/storage-onboarding.browser.ts'
  ],
  security: [
    'tests/security/static-architecture.test.ts',
    './tests/security/browser-security.browser.ts'
  ]
} as const;

const mode = Bun.argv[2] as keyof typeof suites | undefined;
if (!mode || !suites[mode]) {
  throw new Error(`Choose a browser suite: ${Object.keys(suites).join(', ')}.`);
}

const build = Bun.spawnSync({
  cmd: [process.execPath, '--bun', 'vite', 'build'],
  stdout: 'inherit',
  stderr: 'inherit'
});
if (build.exitCode !== 0) process.exit(build.exitCode);

for (const file of suites[mode]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'test', '--max-concurrency', '1', file],
    stdout: 'inherit',
    stderr: 'inherit'
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
