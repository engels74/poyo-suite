import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { resolvePathWithin } from '../platform/app-paths';

export interface CanonicalDirectory {
  root: string;
  path: string;
}

export interface CanonicalFile {
  root: string;
  path: string;
  relativePath: string;
  size: number;
}

function boundaryError(label: string, detail: string): Error {
  return new Error(`${label} ${detail}`);
}

export async function ensureCanonicalRoot(path: string, label: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw boundaryError(label, 'root may not be a symbolic link.');
  }
  return realpath(path);
}

export async function inspectCanonicalRoot(path: string, label: string): Promise<string> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw boundaryError(label, 'root may not be a symbolic link.');
  }
  return realpath(path);
}

export async function ensureCanonicalChildDirectory(
  root: string,
  relativePath: string,
  label: string
): Promise<CanonicalDirectory> {
  const path = resolvePathWithin(root, relativePath);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) await mkdir(path, { mode: 0o700 });
  await assertCanonicalDirectory(root, path, label);
  return { root, path };
}

export async function assertCanonicalDirectory(
  root: string,
  path: string,
  label: string
): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw boundaryError(label, 'directory may not be a symbolic link.');
  }
  resolvePathWithin(root, await realpath(path));
}

function relativeWithin(root: string, path: string, label: string): string {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw boundaryError(label, 'path is outside the configured root.');
  }
  return value;
}

export async function inspectCanonicalFile(
  configuredRoot: string,
  candidate: string,
  label: string
): Promise<CanonicalFile | null> {
  const root = await inspectCanonicalRoot(configuredRoot, label);
  const lexical = isAbsolute(candidate) ? candidate : resolvePathWithin(configuredRoot, candidate);
  const details = await lstat(lexical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile() || details.isSymbolicLink()) {
    throw boundaryError(label, 'path must be a regular non-symlink file.');
  }
  const path = await realpath(lexical);
  resolvePathWithin(root, path);
  const canonicalDetails = await lstat(path);
  if (!canonicalDetails.isFile() || canonicalDetails.isSymbolicLink()) {
    throw boundaryError(label, 'path must remain a regular non-symlink file.');
  }
  return {
    root,
    path,
    relativePath: relativeWithin(root, path, label),
    size: canonicalDetails.size
  };
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
