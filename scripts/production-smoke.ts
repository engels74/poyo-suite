import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const host = '127.0.0.1';
const startupTimeoutMs = 15_000;
const requestTimeoutMs = 1_000;
const routeChecks = [
  ['/', 'Dashboard'],
  ['/studio/image', 'Image Studio'],
  ['/studio/video', 'Video Studio'],
  ['/jobs', 'Jobs'],
  ['/library', 'Library'],
  ['/models', 'Models'],
  ['/presets', 'Presets'],
  ['/settings', 'Settings'],
  ['/settings/diagnostics', 'Diagnostics']
] as const;

function reserveLoopbackPort(): number {
  const reservation = Bun.serve({
    hostname: host,
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  });
  const { port } = reservation;
  reservation.stop(true);
  return port;
}

async function stopProcess(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (server.exitCode !== null) return;

  server.kill('SIGTERM');
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(2_000).then(() => false)
  ]);

  if (!stopped) {
    server.kill('SIGKILL');
    await server.exited;
  }
}

function inspectListener(pid: number, port: number): void {
  const lsof = Bun.which('lsof');
  if (!lsof) {
    console.warn('Listener inspection skipped because lsof is unavailable.');
    return;
  }

  const result = Bun.spawnSync({
    cmd: [lsof, '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const output = result.stdout.toString();
  const listeners = output
    .split('\n')
    .filter((line) => line.includes(`:${port}`) && line.includes('(LISTEN)'));

  if (result.exitCode !== 0 || listeners.length === 0) {
    throw new Error(`Unable to inspect the production listener on port ${port}.`);
  }

  if (!listeners.every((line) => line.includes(`127.0.0.1:${port}`))) {
    throw new Error(`Production server exposed a non-loopback listener:\n${listeners.join('\n')}`);
  }
}

const entrypoint = Bun.file('build/index.js');
if (!(await entrypoint.exists())) {
  throw new Error('Missing build/index.js. Run `bun run build` before the production smoke test.');
}

const port = reserveLoopbackPort();
const url = `http://${host}:${port}/`;
const origin = url.slice(0, -1);
const smokeDirectory = await mkdtemp(join(tmpdir(), 'poyo-production-smoke-'));
const server = Bun.spawn({
  cmd: [process.execPath, './build/index.js'],
  env: {
    ...Bun.env,
    HOST: host,
    ORIGIN: origin,
    PORT: String(port),
    POYO_API_KEY: '',
    PLS_APP_DATA_DIR: join(smokeDirectory, 'data'),
    PLS_DATABASE_PATH: '',
    PLS_MEDIA_DIR: '',
    PLS_LOG_DIR: ''
  },
  stdout: 'pipe',
  stderr: 'pipe'
});
const stdout = new Response(server.stdout).text();
const stderr = new Response(server.stderr).text();

let failure: unknown;

try {
  const deadline = Date.now() + startupTimeoutMs;
  let response: Response | undefined;
  let lastError: unknown;

  while (Date.now() < deadline && server.exitCode === null) {
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (response.ok) break;
      lastError = new Error(`Production server responded with HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(150);
  }

  if (!response?.ok) {
    throw new Error(`Production server did not become ready within ${startupTimeoutMs}ms.`, {
      cause: lastError
    });
  }

  const welcomeBody = await response.text();
  if (
    new URL(response.url).pathname !== '/welcome' ||
    !welcomeBody.includes('Poyo Local Studio') ||
    !welcomeBody.includes('Welcome to Poyo Local Studio')
  ) {
    throw new Error('Fresh production startup did not enter onboarding.');
  }

  const onboardingResponse = await fetch(new URL('/api/onboarding', url), {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': 'same-origin'
    },
    body: JSON.stringify({ dismiss: true }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!onboardingResponse.ok) {
    throw new Error(`Production onboarding responded with HTTP ${onboardingResponse.status}.`);
  }

  for (const [pathname, marker] of routeChecks) {
    const routeResponse = await fetch(new URL(pathname, url), {
      signal: AbortSignal.timeout(requestTimeoutMs)
    });

    if (!routeResponse.ok) {
      throw new Error(`Production route ${pathname} responded with HTTP ${routeResponse.status}.`);
    }

    const body = await routeResponse.text();
    if (!body.includes('Poyo Local Studio') || !body.includes(marker)) {
      throw new Error(`Production route ${pathname} did not contain its application markers.`);
    }
  }

  inspectListener(server.pid, port);
  console.log(
    `Production smoke passed: onboarding and ${routeChecks.length} routes responded on the loopback listener ${url}.`
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await stopProcess(server);
  } catch (error) {
    failure ??= error;
  }
  try {
    await rm(smokeDirectory, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
}

const [serverStdout, serverStderr] = await Promise.all([stdout, stderr]);
if (failure) {
  if (serverStdout.trim()) console.error(`Server stdout:\n${serverStdout.trim()}`);
  if (serverStderr.trim()) console.error(`Server stderr:\n${serverStderr.trim()}`);
  throw failure;
}
