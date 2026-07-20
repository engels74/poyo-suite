export const POYO_API_BASE_URL = 'https://api.poyo.ai';

export type PoyoOperation =
  | 'configuration'
  | 'balance'
  | 'submit'
  | 'status'
  | 'upload_url'
  | 'upload_base64'
  | 'upload_stream';

export type PoyoTaskStatus = 'unknown' | 'not_started' | 'running' | 'finished' | 'failed';

export interface Clock {
  now(): number;
}

export interface Sleeper {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface PoyoSubmitRequest {
  model: string;
  input: Record<string, unknown>;
  callbackUrl?: string;
}

export interface PoyoSubmitResult {
  taskId: string;
  statusRaw: string;
  status: PoyoTaskStatus;
  createdTime: string;
}

export interface PoyoRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeDispatch?: () => Promise<void> | void;
}

export interface PoyoOutputFile {
  url: string;
  fileType: string;
  label: string | null;
  format: string | null;
  contentType: string | null;
  fileName: string | null;
  fileSize: number | null;
}

export interface PoyoStatusResult {
  taskId: string;
  statusRaw: string;
  status: PoyoTaskStatus;
  creditsAmount: number | null;
  files: PoyoOutputFile[];
  createdTime: string;
  progress: number | null;
  errorMessage: string | null;
}

export interface PoyoBalanceResult {
  email: string;
  creditsAmount: number;
  fetchedAt: string;
}

export interface UploadOptions {
  uploadPath?: string;
  fileName?: string;
}

export interface RemoteUrlUpload extends UploadOptions {
  kind: 'remote-url';
  url: string;
  mimeType?: string;
}

export interface Base64Upload extends UploadOptions {
  kind: 'base64';
  data: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface LocalFileUpload extends UploadOptions {
  kind: 'local-file';
  file: Blob;
  mimeType: string;
  sizeBytes: number;
  mediaKind: 'image' | 'video';
}

export type UploadSource = RemoteUrlUpload | Base64Upload | LocalFileUpload;
export type UploadMethod = 'url' | 'base64' | 'stream';

export interface PoyoUploadResult {
  fileId: string;
  fileName: string;
  originalName: string | null;
  fileSize: number;
  mimeType: string;
  uploadPath: string | null;
  fileUrl: string;
  downloadUrl: string;
  uploadTime: string | null;
  expiresAt: string;
}

export interface PoyoRequestMetadata {
  operation: PoyoOperation;
  method: 'GET' | 'POST';
  path: string;
  attempt: number;
  bodyKind: 'none' | 'json' | 'multipart';
  elapsedMs?: number;
  status?: number;
}

export interface PoyoMetadataLogger {
  requestStarted(metadata: PoyoRequestMetadata): Promise<void> | void;
  requestFinished(metadata: PoyoRequestMetadata): Promise<void> | void;
  requestFailed(metadata: PoyoRequestMetadata, error: unknown): Promise<void> | void;
}
