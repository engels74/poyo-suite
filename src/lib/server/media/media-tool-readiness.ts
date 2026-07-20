import type { MediaToolsReadinessDto } from '../../features/settings/contracts';
import { probeMediaTools } from './media-sanitizer';

const READINESS_TTL_MS = 30_000;

interface MediaToolReadinessServiceOptions {
  probe?: () => Promise<MediaToolsReadinessDto>;
  now?: () => number;
}

export class MediaToolReadinessService {
  readonly #probe: () => Promise<MediaToolsReadinessDto>;
  readonly #now: () => number;
  #cached: { value: MediaToolsReadinessDto; expiresAt: number } | undefined;
  #inFlight: Promise<MediaToolsReadinessDto> | undefined;

  constructor(options: MediaToolReadinessServiceOptions = {}) {
    this.#probe = options.probe ?? probeMediaTools;
    this.#now = options.now ?? Date.now;
  }

  getReadiness(): Promise<MediaToolsReadinessDto> {
    return this.#load(true);
  }

  refreshReadiness(): Promise<MediaToolsReadinessDto> {
    return this.#load(false);
  }

  #load(useCache: boolean): Promise<MediaToolsReadinessDto> {
    if (useCache && this.#cached && this.#cached.expiresAt > this.#now()) {
      return Promise.resolve(this.#cached.value);
    }
    if (this.#inFlight) return this.#inFlight;

    const pending = this.#probe()
      .then((value) => {
        this.#cached = { value, expiresAt: this.#now() + READINESS_TTL_MS };
        return value;
      })
      .finally(() => {
        if (this.#inFlight === pending) this.#inFlight = undefined;
      });
    this.#inFlight = pending;
    return pending;
  }
}
