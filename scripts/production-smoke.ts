import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioMockPoyoServer } from '../tests/helpers/studio-mock-poyo-server';

const host = '127.0.0.1';
const startupTimeoutMs = 15_000;
const requestTimeoutMs = 1_000;
const routeChecks = [
  ['/', 'Dashboard'],
  ['/studio/image', 'Image Studio'],
  ['/studio/video', 'Video Studio'],
  ['/jobs', 'Jobs'],
  ['/gallery', 'Gallery'],
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

async function assertNonLoopbackStartRejected(): Promise<void> {
  const rejected = Bun.spawn({
    cmd: [process.execPath, 'run', 'start'],
    env: { ...Bun.env, HOST: '0.0.0.0' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe'
  });
  const exitCode = await Promise.race([
    rejected.exited,
    Bun.sleep(2_000).then(async () => {
      await stopProcess(rejected);
      return null;
    })
  ]);
  const errorOutput = await new Response(rejected.stderr).text();
  if (exitCode === null || exitCode === 0 || !errorOutput.includes('Non-loopback listeners')) {
    throw new Error(
      'The packaged start command did not reject a non-loopback HOST before startup.'
    );
  }
}

const entrypoint = Bun.file('build/index.js');
if (!(await entrypoint.exists())) {
  throw new Error('Missing build/index.js. Run `bun run build` before the production smoke test.');
}

await assertNonLoopbackStartRejected();

const port = reserveLoopbackPort();
const url = `http://${host}:${port}/`;
const origin = url.slice(0, -1);
const smokeDirectory = await mkdtemp(join(tmpdir(), 'poyo-production-smoke-'));
const appData = join(smokeDirectory, 'data');
let mock: Awaited<ReturnType<typeof startStudioMockPoyoServer>>;
try {
  mock = await startStudioMockPoyoServer();
} catch (error) {
  await rm(smokeDirectory, { recursive: true, force: true });
  throw error;
}
const syntheticKey = ['sk', 'production_smoke_canary_never_real_123456'].join('-');
let server: ReturnType<typeof Bun.spawn>;
try {
  server = Bun.spawn({
    cmd: [process.execPath, 'run', 'start'],
    env: {
      ...Bun.env,
      HOST: host,
      ORIGIN: origin,
      PORT: String(port),
      POYO_API_KEY: syntheticKey,
      PLS_APP_DATA_DIR: appData,
      PLS_TEST_MODE: '1',
      PLS_TEST_POYO_BASE_URL: mock.baseUrl,
      PLS_TEST_PUBLIC_IPV4_URL: `${mock.baseUrl}/ip`
    },
    stdout: 'pipe',
    stderr: 'pipe'
  });
} catch (error) {
  await mock.stop().catch(() => undefined);
  await rm(smokeDirectory, { recursive: true, force: true });
  throw error;
}
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
  const onboardingLibrary = await fetch(new URL('/library', url), {
    redirect: 'manual',
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (
    onboardingLibrary.status !== 307 ||
    onboardingLibrary.headers.get('location') !== '/welcome'
  ) {
    throw new Error('Fresh production Library navigation did not enter onboarding.');
  }

  const jsonHeaders = {
    'content-type': 'application/json',
    origin,
    'sec-fetch-site': 'same-origin'
  };
  const connectivity = await fetch(new URL('/api/settings/api-key/connectivity', url), {
    method: 'POST',
    headers: jsonHeaders,
    body: '{}',
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!connectivity.ok) {
    throw new Error(
      `Production connectivity verification responded with HTTP ${connectivity.status}.`
    );
  }
  if (!mock.requests.some((request) => request.pathname === '/api/user/balance')) {
    throw new Error('Production smoke did not verify connectivity through the mock Poyo API.');
  }
  const dismissal = await fetch(new URL('/api/onboarding', url), {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ dismiss: true }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!dismissal.ok) {
    throw new Error(`Production onboarding dismissal responded with HTTP ${dismissal.status}.`);
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
  const removedLibrary = await fetch(new URL('/library?view=list&q=cobalt', url), {
    redirect: 'manual',
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (removedLibrary.status !== 404 || removedLibrary.headers.get('location') !== null) {
    throw new Error('Removed Library route forwarded instead of returning a plain 404.');
  }
  if (mock.ipRequests.length === 0) {
    throw new Error('Production smoke did not resolve public IPv4 through the loopback fixture.');
  }

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
    await mock.stop();
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
