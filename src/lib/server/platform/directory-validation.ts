import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export type DirectoryValidationCode =
  | 'ok'
  | 'empty'
  | 'null_byte'
  | 'not_absolute'
  | 'not_a_directory'
  | 'symlink'
  | 'not_writable'
  | 'create_failed'
  | 'unknown';

export interface DirectoryValidationResult {
  ok: boolean;
  code: DirectoryValidationCode;
  message: string;
  /** Resolved absolute path (best effort; equals the trimmed input when it cannot be resolved). */
  path: string;
  existed: boolean;
  created: boolean;
  freeBytes: number | null;
}

function result(
  code: DirectoryValidationCode,
  message: string,
  path: string,
  extra: Partial<DirectoryValidationResult> = {}
): DirectoryValidationResult {
  return {
    ok: code === 'ok',
    code,
    message,
    path,
    existed: false,
    created: false,
    freeBytes: null,
    ...extra
  };
}

async function freeSpace(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) && available >= 0 ? available : null;
  } catch {
    return null;
  }
}

/**
 * Validate that a user-chosen directory can safely hold generated media. Never throws for
 * expected validation failures — always returns a structured result the UI can render. A
 * candidate is usable only when it is an absolute path resolving to a real (non-symlink)
 * directory we can create and write to.
 */
export async function validateOutputDirectory(input: string): Promise<DirectoryValidationResult> {
  const trimmed = input.trim();
  if (!trimmed) return result('empty', 'Choose a folder for generated media.', trimmed);
  if (trimmed.includes('\0'))
    return result('null_byte', 'The folder path contains an invalid character.', trimmed);
  if (!isAbsolute(trimmed))
    return result('not_absolute', 'Enter a full absolute folder path.', trimmed);

  const path = resolve(trimmed);
  let existed = false;
  let created = false;

  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    info = await lstat(path);
  } catch (error) {
    // Only ENOENT means "does not exist yet" (created below). Any other error — EACCES/EPERM,
    // ELOOP, ENAMETOOLONG — is an expected validation failure, not a server fault, so return a
    // structured result instead of throwing (which would otherwise surface as a generic error).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return result(
        'not_writable',
        'The folder could not be accessed. Check the path and permissions.',
        path,
        {
          freeBytes: await freeSpace(path)
        }
      );
  }

  if (info) {
    if (info.isSymbolicLink())
      return result('symlink', 'The folder may not be a symbolic link.', path);
    if (!info.isDirectory())
      return result('not_a_directory', 'That path exists but is not a folder.', path);
    existed = true;
  } else {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      created = true;
    } catch {
      return result('create_failed', 'The folder could not be created at that location.', path, {
        created: false
      });
    }
  }

  // Use a unique probe filename with an exclusive-create flag so validation never overwrites or
  // deletes an existing user file that happens to share the probe name.
  const probe = join(path, `.poyo-write-check-${randomUUID()}`);
  try {
    await writeFile(probe, 'ok', { mode: 0o600, flag: 'wx' });
    await rm(probe, { force: true });
  } catch {
    return result('not_writable', 'The folder exists but is not writable.', path, {
      existed,
      created,
      freeBytes: await freeSpace(path)
    });
  }

  return result('ok', existed ? 'Folder is ready.' : 'Folder created and ready.', path, {
    existed,
    created,
    freeBytes: await freeSpace(path)
  });
}
