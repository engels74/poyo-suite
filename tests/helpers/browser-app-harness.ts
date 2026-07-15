import { join } from 'node:path';
import { startStudioMockPoyoServer } from './studio-mock-poyo-server';
import { createTemporaryDirectory } from './temporary-directory';

const host = '127.0.0.1';

function reserveLoopbackPort(): number {
  const reservation = Bun.serve({
    hostname: host,
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  });
  const { port } = reservation;
  reservation.stop(true);
  if (port === undefined) throw new Error('Unable to reserve a loopback test port.');
  return port;
}

function spawnPipeProcess(command: string[], environment: Record<string, string | undefined>) {
  return Bun.spawn({
    cmd: command,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
}

type PipeProcess = ReturnType<typeof spawnPipeProcess>;

async function terminate(process: PipeProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  const stopped = await Promise.race([
    process.exited.then(() => true),
    Bun.sleep(2_000).then(() => false)
  ]);
  if (!stopped) {
    process.kill('SIGKILL');
    await process.exited;
  }
}

export async function startBrowserAppHarness(): Promise<{
  url: string;
  appData: string;
  databasePath: string;
  syntheticKey: string;
  mock: Awaited<ReturnType<typeof startStudioMockPoyoServer>>;
  startApp: () => Promise<void>;
  stopApp: () => Promise<void>;
  processPid: () => number | null;
  serverOutput: () => string;
  cleanup: () => Promise<void>;
}> {
  if (!(await Bun.file('build/index.js').exists())) {
    throw new Error(
      'Production browser tests require build/index.js. Run the browser test script.'
    );
  }

  const temporary = await createTemporaryDirectory('poyo-browser-');
  const mock = await startStudioMockPoyoServer();
  const port = reserveLoopbackPort();
  const url = `http://${host}:${port}`;
  const appData = join(temporary.path, 'app-data');
  const databasePath = join(appData, 'data', 'poyo-studio.sqlite');
  const syntheticKey = ['sk', 'browser_suite_canary_never_real_123456'].join('-');
  let active: PipeProcess | null = null;
  let activeStdout: Promise<string> | null = null;
  let activeStderr: Promise<string> | null = null;
  const output: string[] = [];

  async function startApp(): Promise<void> {
    if (active?.exitCode === null) return;
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(Bun.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
    const appProcess = spawnPipeProcess([process.execPath, './build/index.js'], {
      ...inheritedEnvironment,
      HOST: host,
      ORIGIN: url,
      PORT: String(port),
      POYO_API_KEY: syntheticKey,
      PLS_APP_DATA_DIR: appData,
      PLS_TEST_MODE: '1',
      PLS_TEST_POYO_BASE_URL: mock.baseUrl,
      PLS_TEST_JOB_POLL_MS: '75',
      PLS_TEST_JOB_WORKER_MS: '50',
      PLS_TEST_JOB_CREATE_MS: '1200',
      PLS_LOG_MAX_BYTES: '65536',
      PLS_LOG_MAX_FILES: '2'
    });
    active = appProcess;
    activeStdout = new Response(appProcess.stdout).text();
    activeStderr = new Response(appProcess.stderr).text();

    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline && appProcess.exitCode === null) {
      try {
        const response = await fetch(`${url}/api/health`, {
          signal: AbortSignal.timeout(750)
        });
        if (response.ok) return;
        lastError = new Error(`Health endpoint returned HTTP ${response.status}.`);
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(75);
    }

    await stopApp();
    throw new Error(`Production browser server did not become ready.\n${output.join('\n')}`, {
      cause: lastError
    });
  }

  async function stopApp(): Promise<void> {
    const process = active;
    if (!process) return;
    await terminate(process);
    const [stdout, stderr] = await Promise.all([
      activeStdout ?? Promise.resolve(''),
      activeStderr ?? Promise.resolve('')
    ]);
    if (stdout.trim()) output.push(stdout.trim());
    if (stderr.trim()) output.push(stderr.trim());
    active = null;
    activeStdout = null;
    activeStderr = null;
  }

  await startApp();

  return {
    url,
    appData,
    databasePath,
    syntheticKey,
    mock,
    startApp,
    stopApp,
    processPid: () => (active?.exitCode === null ? active.pid : null),
    serverOutput: () => output.join('\n'),
    cleanup: async () => {
      await stopApp();
      await mock.stop();
      await temporary.cleanup();
    }
  };
}
