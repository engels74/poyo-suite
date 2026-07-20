import { Database } from 'bun:sqlite';
import { chmod, cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureAppPaths, resolveAppPaths } from '../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../src/lib/server/platform/database';
import { SettingsRepository } from '../../src/lib/server/settings/settings-repository';
import { updateOnboarding } from '../../src/lib/server/settings/studio-settings';
import { startStudioMockPoyoServer } from './studio-mock-poyo-server';
import { createTemporaryDirectory } from './temporary-directory';

const host = '127.0.0.1';
const cleanupBoundMs = 5_000;
const startScript = join(process.cwd(), 'scripts', 'start.ts');

export type BrowserMediaToolName = 'exiftool' | 'imagemagick' | 'ffmpeg' | 'ffprobe';
export type BrowserMediaToolShimState =
  | 'ready'
  | 'missing'
  | 'outdated'
  | 'error'
  | 'ready-then-outdated'
  | 'runtime-error';

export interface BrowserMediaToolShimController {
  setTool: (name: BrowserMediaToolName, state: BrowserMediaToolShimState) => Promise<void>;
  setTools: (
    states: Partial<Record<BrowserMediaToolName, BrowserMediaToolShimState>>
  ) => Promise<void>;
}

const mediaToolExecutables: Record<BrowserMediaToolName, string> = {
  exiftool: 'exiftool',
  imagemagick: 'magick',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe'
};

const mediaToolVersions: Record<
  BrowserMediaToolName,
  { ready: string; outdated: string; error: string }
> = {
  exiftool: { ready: '13.55', outdated: '13.54', error: 'unparseable exiftool version' },
  imagemagick: {
    ready: 'Version: ImageMagick 7.1.2-27 Q16-HDRI',
    outdated: 'Version: ImageMagick 7.0.11-0 Q16-HDRI',
    error: 'unparseable imagemagick version'
  },
  ffmpeg: {
    ready: 'ffmpeg version 8.1.2 Copyright fixture',
    outdated: 'ffmpeg version 8.0.2 Copyright fixture',
    error: 'unparseable ffmpeg version'
  },
  ffprobe: {
    ready: 'ffprobe version 8.1.2 Copyright fixture',
    outdated: 'ffprobe version 8.0.2 Copyright fixture',
    error: 'unparseable ffprobe version'
  }
};

function mediaToolShimScript(
  name: BrowserMediaToolName,
  state: Exclude<BrowserMediaToolShimState, 'missing'>,
  probeCounterPath: string
): string {
  const versionArgument = name === 'exiftool' ? '-ver' : '-version';
  const versionOutput =
    state === 'outdated' || state === 'error'
      ? mediaToolVersions[name][state]
      : mediaToolVersions[name].ready;
  return `#!${process.execPath}
import { copyFile } from 'node:fs/promises';

const args = Bun.argv.slice(2);
if (args.length === 1 && args[0] === ${JSON.stringify(versionArgument)}) {
  let versionOutput = ${JSON.stringify(versionOutput)};
  if (${JSON.stringify(state)} === 'ready-then-outdated') {
    const counterFile = Bun.file(${JSON.stringify(probeCounterPath)});
    const count = Number((await counterFile.exists()) ? await counterFile.text() : '0');
    await Bun.write(${JSON.stringify(probeCounterPath)}, String(count + 1));
    versionOutput = count === 0
      ? ${JSON.stringify(mediaToolVersions[name].ready)}
      : ${JSON.stringify(mediaToolVersions[name].outdated)};
  }
  process.stdout.write(versionOutput + '\\n');
  process.exit(0);
}

if (${JSON.stringify(state)} === 'runtime-error') {
  process.stderr.write('Deterministic media-tool runtime failure.\\n');
  process.exit(19);
}

function u32be(bytes, offset) {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function imageInfo(bytes) {
  const ascii = (start, end) => new TextDecoder().decode(bytes.slice(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return { format: 'PNG', width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    return {
      format: 'GIF',
      width: (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8),
      height: (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8)
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if ((marker >= 0xc0 && marker <= 0xc3) && length >= 7) {
        return {
          format: 'JPEG',
          width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
          height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
        };
      }
      offset += Math.max(length + 2, 2);
    }
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { format: 'WEBP', width: 16, height: 16 };
  }
  throw new Error('The deterministic media shim received an unsupported image fixture.');
}

async function copyFixture(inputPath, outputPath) {
  await copyFile(inputPath, outputPath);
}

const tool = ${JSON.stringify(name)};
if (tool === 'exiftool') {
  if (args.includes('-json')) {
    process.stdout.write('[{}]');
    process.exit(0);
  }
  if (args.includes('-b') && args.includes('-ICC_Profile')) process.exit(0);
  if (args.includes('-s3') && args.includes('-Orientation')) process.exit(0);
  const outputIndex = args.indexOf('-o');
  if (outputIndex >= 0) {
    await copyFixture(args.at(-1), args[outputIndex + 1]);
    process.exit(0);
  }
  if (args.includes('-overwrite_original') && args.includes('-tagsFromFile')) process.exit(0);
}

if (tool === 'imagemagick') {
  if (args[0] === 'identify') {
    const bytes = new Uint8Array(await Bun.file(args.at(-1)).arrayBuffer());
    const info = imageInfo(bytes);
    process.stdout.write(
      [info.format, info.width, info.height, 'srgb', 'Undefined', 0, 'Undefined'].join('\\t') + '\\n'
    );
    process.exit(0);
  }
  const orientIndex = args.indexOf('-auto-orient');
  if (orientIndex > 0) {
    await copyFixture(args[orientIndex - 1], args[orientIndex + 1]);
    process.exit(0);
  }
}

if (tool === 'ffprobe' && args.includes('-show_streams')) {
  const sourcePath = args.at(-1);
  const sanitized = sourcePath.includes('.sanitized.');
  process.stdout.write(JSON.stringify({
    streams: [{
      index: 0,
      codec_name: 'h264',
      codec_type: 'video',
      width: 16,
      height: 16,
      pix_fmt: 'yuv420p',
      time_base: '1/10240',
      duration: '0.200000',
      disposition: {}
    }],
    chapters: [],
    format: {
      duration: '0.200000',
      tags: sanitized ? {} : { title: 'Private fixture title' }
    }
  }));
  process.exit(0);
}

if (tool === 'ffmpeg') {
  const inputIndex = args.indexOf('-i');
  const outputPath = args.at(-1);
  if (inputIndex >= 0 && outputPath !== '-') {
    await copyFixture(args[inputIndex + 1], outputPath);
  }
  process.exit(0);
}

process.stderr.write('Unsupported deterministic media-tool shim command.\\n');
process.exit(20);
`;
}

async function createMediaToolShims(
  directory: string,
  initial: Partial<Record<BrowserMediaToolName, BrowserMediaToolShimState>>
): Promise<BrowserMediaToolShimController> {
  await mkdir(directory, { recursive: true });

  async function setTool(
    name: BrowserMediaToolName,
    state: BrowserMediaToolShimState
  ): Promise<void> {
    const executable = join(directory, mediaToolExecutables[name]);
    const probeCounter = `${executable}.probe-count`;
    await rm(probeCounter, { force: true });
    if (state === 'missing') {
      await rm(executable, { force: true });
      return;
    }
    await Bun.write(executable, mediaToolShimScript(name, state, probeCounter));
    await chmod(executable, 0o755);
  }

  async function setTools(
    states: Partial<Record<BrowserMediaToolName, BrowserMediaToolShimState>>
  ): Promise<void> {
    await Promise.all(
      Object.entries(states).map(([name, state]) => setTool(name as BrowserMediaToolName, state))
    );
  }

  await setTools(
    Object.fromEntries(
      (Object.keys(mediaToolExecutables) as BrowserMediaToolName[]).map((name) => [
        name,
        initial[name] ?? 'missing'
      ])
    )
  );
  return { setTool, setTools };
}

export interface StageTracker {
  currentStage?: string;
  lastStage?: string;
  boundMs?: number;
}

export interface StageTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(token: unknown): void;
  pendingCount(): number;
}

export interface CleanupOutcome {
  name: string;
  status: 'fulfilled' | 'rejected';
  reason?: unknown;
}

export interface CleanupStep {
  name: string;
  run: () => void | Promise<void>;
}

export class NamedStageTimeoutError extends Error {
  readonly stage: string;
  readonly lastStage: string | undefined;
  readonly boundMs: number;

  constructor(stage: string, lastStage: string | undefined, boundMs: number, cause: DOMException) {
    super(`Stage "${stage}" exceeded its ${boundMs} ms bound.`, { cause });
    this.name = 'NamedStageTimeoutError';
    this.stage = stage;
    this.lastStage = lastStage;
    this.boundMs = boundMs;
  }
}

const realStageTimer: StageTimer = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
  pendingCount: () => 0
};

export async function runNamedStage<T>(
  tracker: StageTracker,
  stage: string,
  boundMs: number,
  operation: () => T | Promise<T>,
  options: { timer?: StageTimer; dispose?: () => void | Promise<void> } = {}
): Promise<T> {
  const timer = options.timer ?? realStageTimer;
  tracker.currentStage = stage;
  tracker.boundMs = boundMs;
  let token: unknown;
  let failure: unknown;
  let value!: T;

  try {
    const timeoutCause = new DOMException(`Stage ${stage} timed out.`, 'TimeoutError');
    const timeout = new Promise<never>((_, reject) => {
      token = timer.set(
        () => reject(new NamedStageTimeoutError(stage, tracker.lastStage, boundMs, timeoutCause)),
        boundMs
      );
    });
    value = await Promise.race([Promise.resolve().then(operation), timeout]);
    tracker.lastStage = stage;
  } catch (error) {
    failure =
      error instanceof NamedStageTimeoutError
        ? error
        : new Error(`Stage "${stage}" failed.`, { cause: error });
  } finally {
    if (token !== undefined) timer.clear(token);
    if (options.dispose) {
      try {
        await options.dispose();
      } catch (disposeError) {
        const aggregate = new AggregateError([disposeError], `Stage "${stage}" cleanup failed.`, {
          cause: failure ?? disposeError
        });
        Object.assign(aggregate, {
          diagnostics: {
            stage,
            lastStage: tracker.lastStage,
            boundMs,
            cleanup: [{ name: `${stage} disposer`, status: 'rejected', reason: disposeError }]
          }
        });
        failure = aggregate;
      }
    }
  }

  if (failure !== undefined) throw failure;
  return value;
}

export async function composeCleanupFailure(
  primary: unknown,
  diagnostics: Record<string, unknown>,
  steps: CleanupStep[]
): Promise<CleanupOutcome[]> {
  const cleanup: CleanupOutcome[] = [];
  const errors: unknown[] = [];

  for (const step of steps) {
    try {
      await step.run();
      cleanup.push({ name: step.name, status: 'fulfilled' });
    } catch (reason) {
      cleanup.push({ name: step.name, status: 'rejected', reason });
      errors.push(reason);
    }
  }

  if (primary === undefined && errors.length === 0) return cleanup;

  const cause = primary ?? errors[0];
  const stage = typeof diagnostics.stage === 'string' ? ` at ${diagnostics.stage}` : '';
  const primarySummary =
    primary instanceof Error ? `${primary.name}: ${primary.message}` : String(primary ?? errors[0]);
  const reportErrors =
    errors.length > 0
      ? errors
      : [
          new Error(`Primary browser harness failure${stage}: ${primarySummary}`, {
            cause: primary
          })
        ];
  const aggregate = new AggregateError(
    reportErrors,
    `Browser harness operation failed${stage}: ${primarySummary}`,
    { cause }
  );
  Object.assign(aggregate, { diagnostics: { ...diagnostics, cleanup } });
  throw aggregate;
}

export async function failAppHealthAfterRollback(
  primary: unknown,
  options: {
    appPid: number;
    lastProbeError: unknown;
    stopApp: () => Promise<void>;
    serverOutput: () => string;
  }
): Promise<never> {
  const diagnostics: Record<string, unknown> = {
    stage: 'app health',
    appPid: options.appPid,
    lastProbeError: options.lastProbeError
  };
  await composeCleanupFailure(primary, diagnostics, [
    { name: 'failed app stop', run: options.stopApp },
    {
      name: 'failed app diagnostics',
      run: () => {
        diagnostics.serverOutput = options.serverOutput();
      }
    }
  ]);
  throw primary;
}

async function bounded<T>(
  label: string,
  milliseconds: number,
  operation: () => Promise<T>
): Promise<T> {
  const tracker: StageTracker = {};
  return runNamedStage(tracker, label, milliseconds, operation);
}

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

function spawnPipeProcess(
  command: string[],
  environment: Record<string, string | undefined>,
  workingDirectory?: string
) {
  return Bun.spawn({
    cmd: command,
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
}

type PipeProcess = ReturnType<typeof spawnPipeProcess>;

async function waitForExit(process: PipeProcess, label: string): Promise<void> {
  if (process.exitCode !== null) return;
  await bounded(label, cleanupBoundMs, async () => {
    await process.exited;
  });
}

async function terminate(process: PipeProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  try {
    await waitForExit(process, `app ${process.pid} SIGTERM exit`);
    return;
  } catch (termError) {
    process.kill('SIGKILL');
    try {
      await waitForExit(process, `app ${process.pid} SIGKILL exit`);
    } catch (killError) {
      throw new AggregateError(
        [termError, killError],
        `Unable to stop app process ${process.pid}.`,
        {
          cause: termError
        }
      );
    }
  }
}

async function endpointIsClosed(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export interface BrowserAppHarness {
  url: string;
  appData: string;
  databasePath: string;
  temporaryPath: string;
  syntheticKey: string;
  mock: Awaited<ReturnType<typeof startStudioMockPoyoServer>>;
  mediaTools: BrowserMediaToolShimController;
  startApp: () => Promise<void>;
  stopApp: () => Promise<void>;
  processPid: () => number | null;
  processState: () => { activePid: number | null; recordedPids: number[]; exited: boolean };
  serverOutput: () => string;
  cleanup: () => Promise<void>;
}

export interface BrowserAppHarnessOptions {
  /** Run from a private project copy without application-root or API-key environment overrides. */
  freshOnboarding?: boolean;
  /** Explicitly seed onboarding completion for fixtures that are not exercising first-run setup. */
  completedOnboarding?: boolean;
  /** Configure isolated media tools. Unspecified tools are unavailable. */
  mediaToolShims?: Partial<Record<BrowserMediaToolName, BrowserMediaToolShimState>>;
}

export async function startBrowserAppHarness(
  options: BrowserAppHarnessOptions = {}
): Promise<BrowserAppHarness> {
  if (!(await Bun.file('build/index.js').exists())) {
    throw new Error(
      'Production browser tests require build/index.js. Run the browser test script.'
    );
  }

  const temporary = await createTemporaryDirectory('poyo-browser-');
  let acquiredMock: Awaited<ReturnType<typeof startStudioMockPoyoServer>> | undefined;
  let port!: number;

  try {
    acquiredMock = await startStudioMockPoyoServer();
    if (!acquiredMock) throw new Error('Mock server startup returned no server.');
    port = reserveLoopbackPort();
  } catch (primary) {
    const failedMock = acquiredMock;
    await composeCleanupFailure(
      primary,
      {
        stage: 'initial browser harness resource acquisition',
        mockUrl: failedMock?.baseUrl ?? null,
        temporaryPath: temporary.path
      },
      [
        {
          name: 'mock-server stop',
          run: async () => {
            if (failedMock) await bounded('mock-server stop', cleanupBoundMs, failedMock.stop);
          }
        },
        {
          name: 'mock endpoint closure',
          run: async () => {
            if (failedMock && !(await endpointIsClosed(failedMock.baseUrl)))
              throw new Error(`Mock endpoint ${failedMock.baseUrl} remains open.`);
          }
        },
        {
          name: 'temporary-directory cleanup',
          run: async () => bounded('temporary-directory cleanup', cleanupBoundMs, temporary.cleanup)
        },
        {
          name: 'temporary-directory absence',
          run: async () => {
            if (!(await pathIsAbsent(temporary.path)))
              throw new Error(`Harness temporary root ${temporary.path} remains on disk.`);
          }
        }
      ]
    );
    throw primary;
  }
  const runningMock = acquiredMock;
  const url = `http://${host}:${port}`;
  const deploymentRoot = join(temporary.path, 'deployment');
  const mediaToolShimDirectory = join(temporary.path, 'media-tool-shims');
  const mediaTools = await createMediaToolShims(
    mediaToolShimDirectory,
    options.mediaToolShims ?? {}
  );
  const isolatedEnvironment = {
    HOME: join(temporary.path, 'home'),
    XDG_DATA_HOME: join(temporary.path, 'xdg'),
    APPDATA: join(temporary.path, 'appdata'),
    LOCALAPPDATA: join(temporary.path, 'local-appdata')
  };
  if (options.freshOnboarding) {
    await mkdir(deploymentRoot, { recursive: true });
    await cp('build', join(deploymentRoot, 'build'), { recursive: true });
    await Bun.write(
      join(deploymentRoot, 'package.json'),
      `${JSON.stringify({ name: 'poyo-local-studio-browser-fixture', private: true, type: 'module' })}\n`
    );
  }
  const appData = options.freshOnboarding
    ? join(deploymentRoot, 'data')
    : join(temporary.path, 'app-data');
  const databasePath = join(appData, 'state', 'poyo-studio.sqlite');
  const syntheticKey = ['sk', 'browser_suite_canary_never_real_123456'].join('-');
  if (options.completedOnboarding ?? !options.freshOnboarding) {
    if (options.freshOnboarding) {
      const seededPaths = resolveAppPaths({
        environment: {},
        projectRoot: deploymentRoot
      });
      await ensureAppPaths(seededPaths);
    }
    const seededDatabasePath = databasePath;
    await mkdir(dirname(seededDatabasePath), { recursive: true });
    const seededDatabase = await openDatabase(seededDatabasePath);
    try {
      updateOnboarding(new SettingsRepository(seededDatabase), { complete: true });
    } finally {
      seededDatabase.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
      seededDatabase.close();
    }
    await Promise.all([
      rm(`${seededDatabasePath}-wal`, { force: true }),
      rm(`${seededDatabasePath}-shm`, { force: true })
    ]);
  }
  let active: PipeProcess | null = null;
  let activeStdout: Promise<string> | null = null;
  let activeStderr: Promise<string> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let mockStopped = false;
  const processes: PipeProcess[] = [];
  const output: string[] = [];

  async function drainActiveProcess(process: PipeProcess): Promise<void> {
    const stdoutPromise = activeStdout ?? Promise.resolve('');
    const stderrPromise = activeStderr ?? Promise.resolve('');
    const [stdout, stderr] = await Promise.all([
      bounded(`app ${process.pid} stdout drain`, cleanupBoundMs, () => stdoutPromise),
      bounded(`app ${process.pid} stderr drain`, cleanupBoundMs, () => stderrPromise)
    ]);
    if (stdout.trim()) output.push(stdout.trim());
    if (stderr.trim()) output.push(stderr.trim());
  }

  async function stopApp(): Promise<void> {
    const process = active;
    if (!process) return;
    let primary: unknown;
    try {
      await terminate(process);
    } catch (error) {
      primary = error;
    }
    try {
      await drainActiveProcess(process);
    } catch (error) {
      if (primary === undefined) primary = error;
      else
        primary = new AggregateError([primary, error], `Failed to stop app ${process.pid}.`, {
          cause: primary
        });
    } finally {
      if (active === process) {
        active = null;
        activeStdout = null;
        activeStderr = null;
      }
    }
    const runtimeDatabasePath = databasePath;
    if (primary === undefined && (await Bun.file(runtimeDatabasePath).exists())) {
      try {
        const database = new Database(runtimeDatabasePath);
        try {
          database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
        } finally {
          database.close();
        }
        await Promise.all([
          rm(`${runtimeDatabasePath}-wal`, { force: true }),
          rm(`${runtimeDatabasePath}-shm`, { force: true })
        ]);
      } catch (error) {
        primary = error;
      }
    }
    if (primary !== undefined) throw primary;
  }

  async function startApp(): Promise<void> {
    if (active?.exitCode === null) return;
    if (active) await stopApp();

    const inheritedEnvironment = Object.fromEntries(
      Object.entries(Bun.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
    const appProcess = spawnPipeProcess(
      [process.execPath, startScript],
      {
        ...inheritedEnvironment,
        ...isolatedEnvironment,
        PATH: mediaToolShimDirectory,
        HOST: host,
        ORIGIN: url,
        PORT: String(port),
        POYO_API_KEY: options.freshOnboarding ? '' : syntheticKey,
        PLS_APP_DATA_DIR: options.freshOnboarding ? '' : appData,
        PLS_TEST_MODE: '1',
        PLS_TEST_POYO_BASE_URL: runningMock.baseUrl,
        PLS_TEST_PUBLIC_IPV4_URL: `${runningMock.baseUrl}/ip`,
        PLS_TEST_JOB_POLL_MS: '75',
        PLS_TEST_JOB_WORKER_MS: '50',
        PLS_TEST_JOB_CREATE_MS: '1200',
        PLS_LOG_MAX_BYTES: '65536',
        PLS_LOG_MAX_FILES: '2'
      },
      options.freshOnboarding ? deploymentRoot : undefined
    );
    processes.push(appProcess);
    active = appProcess;
    activeStdout = new Response(appProcess.stdout).text();
    activeStderr = new Response(appProcess.stderr).text();

    let lastError: unknown;
    try {
      await bounded('app health', 15_000, async () => {
        while (appProcess.exitCode === null) {
          try {
            const readinessPath = options.freshOnboarding
              ? '/poyo-local-studio-logo.svg'
              : '/api/health';
            const response = await fetch(`${url}${readinessPath}`, {
              signal: AbortSignal.timeout(750)
            });
            if (response.ok) return;
            lastError = new Error(`Health endpoint returned HTTP ${response.status}.`);
          } catch (error) {
            lastError = error;
          }
          await Bun.sleep(75);
        }
        throw new Error(`Production browser server exited with code ${appProcess.exitCode}.`);
      });
    } catch (primary) {
      await failAppHealthAfterRollback(primary, {
        appPid: appProcess.pid,
        lastProbeError: lastError,
        stopApp,
        serverOutput: () => output.join('\n')
      });
    }
  }

  async function cleanupResources(): Promise<void> {
    const diagnostics: Record<string, unknown> = {
      stage: 'browser app harness cleanup',
      appPids: processes.map((process) => process.pid),
      appUrl: url,
      mockUrl: runningMock.baseUrl,
      temporaryPath: temporary.path
    };
    await composeCleanupFailure(undefined, diagnostics, [
      { name: 'app stop', run: stopApp },
      {
        name: 'app process exit verification',
        run: async () => {
          const live = processes
            .filter((process) => process.exitCode === null)
            .map((process) => process.pid);
          if (live.length > 0) throw new Error(`App processes remain live: ${live.join(', ')}.`);
        }
      },
      {
        name: 'app endpoint closure',
        run: async () => {
          if (!(await endpointIsClosed(`${url}/api/health`)))
            throw new Error(`App endpoint ${url} remains open.`);
        }
      },
      {
        name: 'mock-server stop',
        run: async () => {
          if (mockStopped) return;
          await bounded('mock-server stop', cleanupBoundMs, runningMock.stop);
          mockStopped = true;
        }
      },
      {
        name: 'mock endpoint closure',
        run: async () => {
          if (!(await endpointIsClosed(runningMock.baseUrl)))
            throw new Error(`Mock endpoint ${runningMock.baseUrl} remains open.`);
        }
      },
      {
        name: 'temporary-directory cleanup',
        run: async () => bounded('temporary-directory cleanup', cleanupBoundMs, temporary.cleanup)
      },
      {
        name: 'temporary-directory absence',
        run: async () => {
          if (!(await pathIsAbsent(temporary.path)))
            throw new Error(`Harness temporary root ${temporary.path} remains on disk.`);
        }
      }
    ]);
  }

  async function cleanupOnce(): Promise<void> {
    cleanupPromise ??= cleanupResources();
    await cleanupPromise;
  }

  try {
    await startApp();
  } catch (primary) {
    await composeCleanupFailure(primary, { stage: 'initial app startup' }, [
      { name: 'initial browser harness resource rollback', run: cleanupOnce }
    ]);
    throw primary;
  }

  return {
    url,
    appData,
    databasePath,
    temporaryPath: temporary.path,
    syntheticKey,
    mock: runningMock,
    mediaTools,
    startApp,
    stopApp,
    processPid: () => (active?.exitCode === null ? active.pid : null),
    processState: () => ({
      activePid: active?.exitCode === null ? active.pid : null,
      recordedPids: processes.map((process) => process.pid),
      exited: processes.every((process) => process.exitCode !== null)
    }),
    serverOutput: () => output.join('\n'),
    cleanup: cleanupOnce
  };
}
