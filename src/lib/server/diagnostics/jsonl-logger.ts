import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { redact, safeErrorSummary } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface FileInfo {
  size: number;
  mtimeMs: number;
}

export interface LoggerFileOperations {
  append(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileInfo | null>;
}

const defaultFileOperations: LoggerFileOperations = {
  append: (path, content) => appendFile(path, content, { encoding: 'utf8', mode: 0o600 }),
  list: async (path) => readdir(path),
  mkdir: async (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
  remove: async (path) => unlink(path),
  rename: async (from, to) => rename(from, to),
  stat: async (path) => {
    try {
      const info = await stat(path);
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
};

export interface LoggerConfig {
  directory: string;
  separateErrorFile?: boolean;
  maxBytes?: number;
  maxAgeMs?: number;
  retentionAgeMs?: number;
  maxRotatedFiles?: number;
  now?: () => Date;
  files?: LoggerFileOperations;
  onRotationError?: (error: unknown) => void;
}

export interface LogContext {
  correlationId?: string;
  localJobId?: string;
  poyoTaskId?: string;
  data?: unknown;
}

export interface LoggerDiagnostics {
  status: 'ok' | 'degraded';
  separateErrorFile: boolean;
  files: number;
  bytes: number;
  lastRotationError: { name: string; message: string } | null;
  rotation: LoggerRotationSettings;
}

export interface LoggerRotationSettings {
  separateErrorFile: boolean;
  maxBytes: number;
  maxAgeMs: number;
  retentionAgeMs: number;
  maxRotatedFiles: number;
}

export class StructuredLogger {
  private readonly files: LoggerFileOperations;
  private readonly now: () => Date;
  private rotation: LoggerRotationSettings;
  private queue = Promise.resolve();
  private lastRotationError: { name: string; message: string } | null = null;

  constructor(private readonly config: LoggerConfig) {
    this.files = config.files ?? defaultFileOperations;
    this.now = config.now ?? (() => new Date());
    this.rotation = {
      separateErrorFile: config.separateErrorFile ?? true,
      maxBytes: config.maxBytes ?? 5 * 1024 * 1024,
      maxAgeMs: config.maxAgeMs ?? 24 * 60 * 60 * 1000,
      retentionAgeMs: config.retentionAgeMs ?? 14 * 24 * 60 * 60 * 1000,
      maxRotatedFiles: config.maxRotatedFiles ?? 10
    };
  }

  updateRotationSettings(settings: LoggerRotationSettings): void {
    const valid =
      typeof settings.separateErrorFile === 'boolean' &&
      Number.isSafeInteger(settings.maxBytes) &&
      settings.maxBytes >= 64 * 1024 &&
      settings.maxBytes <= 1024 * 1024 * 1024 &&
      Number.isSafeInteger(settings.maxAgeMs) &&
      settings.maxAgeMs >= 60_000 &&
      settings.maxAgeMs <= 30 * 24 * 60 * 60 * 1000 &&
      Number.isSafeInteger(settings.retentionAgeMs) &&
      settings.retentionAgeMs >= 60 * 60 * 1000 &&
      settings.retentionAgeMs <= 365 * 24 * 60 * 60 * 1000 &&
      Number.isSafeInteger(settings.maxRotatedFiles) &&
      settings.maxRotatedFiles >= 1 &&
      settings.maxRotatedFiles <= 100;
    if (!valid) throw new Error('Log rotation settings are outside the supported bounds.');
    this.rotation = { ...settings };
  }

  rotationSettings(): LoggerRotationSettings {
    return { ...this.rotation };
  }

  private activeFile(level: LogLevel): string {
    return join(
      this.config.directory,
      level === 'error' && this.rotation.separateErrorFile ? 'error.jsonl' : 'app.jsonl'
    );
  }

  private async nextRotationPath(path: string): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt}`;
      const candidate = `${path}.${stamp}${suffix}`;
      if (!(await this.files.stat(candidate))) return candidate;
    }
    throw new Error('Unable to allocate a rotated log filename.');
  }

  private async prune(path: string): Promise<void> {
    const prefix = `${basename(path)}.`;
    const now = this.now().getTime();
    const candidates = await this.files.list(this.config.directory);
    const records = (
      await Promise.all(
        candidates
          .filter((file) => file.startsWith(prefix))
          .map(async (file) => {
            const fullPath = join(this.config.directory, file);
            return { fullPath, info: await this.files.stat(fullPath) };
          })
      )
    )
      .filter((record): record is { fullPath: string; info: FileInfo } => record.info !== null)
      .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);

    for (const [index, record] of records.entries()) {
      if (
        index >= this.rotation.maxRotatedFiles ||
        now - record.info.mtimeMs > this.rotation.retentionAgeMs
      ) {
        await this.files.remove(record.fullPath).catch(() => undefined);
      }
    }
  }

  private async rotateIfNeeded(path: string, incomingBytes: number): Promise<void> {
    const info = await this.files.stat(path);
    if (!info) return;
    const exceedsSize = info.size + incomingBytes > this.rotation.maxBytes;
    const exceedsAge = this.now().getTime() - info.mtimeMs >= this.rotation.maxAgeMs;
    if (!exceedsSize && !exceedsAge) return;

    try {
      await this.files.rename(path, await this.nextRotationPath(path));
      await this.prune(path);
      this.lastRotationError = null;
    } catch (error) {
      this.lastRotationError = safeErrorSummary(error);
      this.config.onRotationError?.(error);
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  log(level: LogLevel, event: string, context: LogContext = {}): Promise<void> {
    return this.enqueue(async () => {
      await this.files.mkdir(this.config.directory);
      const record = redact({
        timestamp: this.now().toISOString(),
        level,
        event,
        correlationId: context.correlationId ?? null,
        localJobId: context.localJobId ?? null,
        poyoTaskId: context.poyoTaskId ?? null,
        data: context.data ?? null
      });
      const line = `${JSON.stringify(record)}\n`;
      const path = this.activeFile(level);
      await this.rotateIfNeeded(path, Buffer.byteLength(line));
      await this.files.append(path, line);
    });
  }

  info(event: string, context?: LogContext): Promise<void> {
    return this.log('info', event, context);
  }

  warn(event: string, context?: LogContext): Promise<void> {
    return this.log('warn', event, context);
  }

  error(event: string, error: unknown, context: LogContext = {}): Promise<void> {
    return this.log('error', event, { ...context, data: { error, context: context.data ?? null } });
  }

  async diagnostics(): Promise<LoggerDiagnostics> {
    await this.queue;
    await this.files.mkdir(this.config.directory);
    const names = await this.files.list(this.config.directory);
    const infos = await Promise.all(
      names
        .filter((name) => name.startsWith('app.jsonl') || name.startsWith('error.jsonl'))
        .map((name) => this.files.stat(join(this.config.directory, name)))
    );

    return {
      status: this.lastRotationError ? 'degraded' : 'ok',
      separateErrorFile: this.rotation.separateErrorFile,
      files: infos.filter(Boolean).length,
      bytes: infos.reduce((total, info) => total + (info?.size ?? 0), 0),
      lastRotationError: this.lastRotationError,
      rotation: this.rotationSettings()
    };
  }
}
