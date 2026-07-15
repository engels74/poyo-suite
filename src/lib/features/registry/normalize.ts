import { IMAGE_REGISTRY_ENTRIES } from './image-registry';
import type {
  ExpertOverride,
  GuidedImageRequest,
  ImageRegistryEntry,
  NormalizedPreview
} from './types';

export class RegistryValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' '));
    this.name = 'RegistryValidationError';
  }
}
const protectedKeys =
  /(?:model|callback|api.?key|authorization|cookie|credential|password|secret|token|path|file|directory)/i;
function entryFor(key: string): ImageRegistryEntry {
  const entry = IMAGE_REGISTRY_ENTRIES.find((item) => item.key === key);
  if (!entry) throw new RegistryValidationError(['Unknown registry workflow.']);
  return entry;
}
function imageUrls(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new RegistryValidationError(['Reference image URL is invalid.']);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new RegistryValidationError([
        'Reference images require HTTP(S) URLs without credentials.'
      ]);
  }
  return values;
}
function validate(entry: ImageRegistryEntry, values: GuidedImageRequest): string[] {
  const issues: string[] = [];
  for (const field of entry.fields) {
    const value = values[field.key as keyof GuidedImageRequest] ?? field.default;
    if (field.required && (value === undefined || value === ''))
      issues.push(`${field.key} is required.`);
    if (typeof value === 'string' && field.kind === 'text') {
      if (field.min !== undefined && value.length < field.min)
        issues.push(`${field.key} is too short.`);
      if (field.max !== undefined && value.length > field.max)
        issues.push(`${field.key} is too long.`);
    }
    if (typeof value === 'number') {
      if (field.min !== undefined && value < field.min)
        issues.push(`${field.key} is below minimum.`);
      if (field.max !== undefined && value > field.max)
        issues.push(`${field.key} exceeds maximum.`);
    }
    if (field.enum && value !== undefined && !field.enum.includes(String(value)))
      issues.push(`${field.key} is unsupported.`);
  }
  const refs = values.imageUrls?.length ?? 0;
  const role = entry.inputRoles.find((item) => item.role === 'reference');
  if (role) {
    if (role.required && refs < role.min)
      issues.push(`At least ${role.min} reference image is required.`);
    if (role.max !== null && refs > role.max)
      issues.push(`At most ${role.max} reference images are supported.`);
  } else if (refs) issues.push('Reference images are not supported for this workflow.');
  const hasDimensions = values.width !== undefined || values.height !== undefined;
  if (hasDimensions) {
    if (!entry.output.customSize) issues.push('Custom dimensions are not supported.');
    if (
      !Number.isInteger(values.width) ||
      !Number.isInteger(values.height) ||
      (values.width ?? 0) <= 0 ||
      (values.height ?? 0) <= 0
    )
      issues.push('Custom dimensions must be positive integer values.');
    const width = values.width ?? 0;
    const height = values.height ?? 0;
    const constraints = entry.validation.customDimensions;
    if (constraints?.divisor && (width % constraints.divisor || height % constraints.divisor))
      issues.push(`Custom dimensions must be divisible by ${constraints.divisor}.`);
    if (constraints?.maxEdge && Math.max(width, height) > constraints.maxEdge)
      issues.push(`Custom dimensions have a maximum edge of ${constraints.maxEdge}.`);
    const pixels = width * height;
    if (constraints?.minPixels && pixels < constraints.minPixels)
      issues.push(`Custom dimensions require at least ${constraints.minPixels} pixels.`);
    if (constraints?.maxPixels && pixels > constraints.maxPixels)
      issues.push(`Custom dimensions allow at most ${constraints.maxPixels} pixels.`);
    if (
      constraints?.maxAspectRatio &&
      Math.max(width / height, height / width) > constraints.maxAspectRatio
    )
      issues.push(`Custom dimensions allow an aspect ratio up to ${constraints.maxAspectRatio}:1.`);
    if (values.aspectRatio)
      issues.push('Custom dimensions and a size preset are mutually exclusive.');
    if (
      ['Seedream 4.5', 'Seedream 5.0 Lite', 'Seedream 5.0 Pro'].includes(entry.family) &&
      values.resolution
    )
      issues.push(`${entry.family} accepts custom dimensions or resolution, not both.`);
    if (entry.family === 'GPT Image 2' && values.resolution !== '2K' && values.resolution !== '4K')
      issues.push('GPT Image 2 custom dimensions require 2K or 4K resolution.');
  }
  if (
    ['Seedream 4.5', 'Seedream 5.0 Lite', 'Seedream 5.0 Pro'].includes(entry.family) &&
    values.aspectRatio &&
    values.resolution
  )
    issues.push(`${entry.family} accepts resolution or aspect ratio, not both.`);
  if (entry.family === 'Seedream 4' && refs + (values.n ?? 1) > 15)
    issues.push('Seedream 4 requires image_urls plus n to be at most 15.');
  if (
    entry.publicModelId === 'z-image' &&
    entry.workflow === 'text-to-image' &&
    !values.aspectRatio &&
    !values.size
  )
    issues.push('Z-Image text generation requires size.');
  if (entry.family === 'Flux.2' && (!values.aspectRatio || !values.resolution))
    issues.push('Flux.2 requires both size and resolution.');
  if (
    entry.family === 'Nano Banana 2 / Pro' &&
    !entry.publicModelId.includes('pro') &&
    values.webSearch
  )
    issues.push('Web search is supported only by Nano Banana Pro variants.');
  return issues;
}
export function normalizeImageRequest(
  entryKey: string,
  values: GuidedImageRequest,
  overrides: readonly ExpertOverride[] = []
): NormalizedPreview {
  const entry = entryFor(entryKey);
  const issues = validate(entry, values);
  if (issues.length) throw new RegistryValidationError(issues);
  const input: Record<string, unknown> = {};
  for (const field of entry.fields) {
    const value = values[field.key as keyof GuidedImageRequest] ?? field.default;
    if (value === undefined) continue;
    if (field.key === 'dimensions') continue;
    if (field.key === 'aspectRatio') {
      input.size = value;
      continue;
    }
    input[field.apiKey] = value;
  }
  if (values.width !== undefined && values.height !== undefined)
    input.size =
      entry.payload.dimensionsEncoding === 'width-x-height-string'
        ? `${values.width}x${values.height}`
        : { width: values.width, height: values.height };
  const refs = imageUrls(values.imageUrls);
  if (refs) input.image_urls = refs;
  if (values.maskUrl) input.mask_url = imageUrls([values.maskUrl])?.[0];
  if (entry.output.safetyChecker) input.enable_safety_checker = values.enableSafetyChecker ?? false;
  else delete input.enable_safety_checker;
  const verifiedKeys = new Set(
    entry.fields.map((field) => field.apiKey).concat(['prompt', 'image_urls', 'mask_url', 'size'])
  );
  const expertDiff: NormalizedPreview['expertDiff'] = [];
  for (const override of overrides) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(override.key) || protectedKeys.test(override.key))
      throw new RegistryValidationError([`Expert override ${override.key} is protected.`]);
    if (verifiedKeys.has(override.key))
      throw new RegistryValidationError([
        `Use the guided field for verified parameter ${override.key}.`
      ]);
    if (
      override.value === undefined ||
      typeof override.value === 'function' ||
      typeof override.value === 'symbol'
    )
      throw new RegistryValidationError([
        `Expert override ${override.key} is not JSON serializable.`
      ]);
    input[override.key] = override.value;
    expertDiff.push({ key: override.key, status: 'unverified', value: override.value });
  }
  return {
    request: { model: entry.publicModelId, input },
    guidedInput: input,
    expertDiff,
    warnings: expertDiff.map((item) => `${item.key} is an unverified expert override.`)
  };
}
export function minimumValidRequest(entry: ImageRegistryEntry): GuidedImageRequest {
  const values: GuidedImageRequest = { prompt: 'studio image' };
  const role = entry.inputRoles.find((item) => item.role === 'reference');
  if (role?.required)
    values.imageUrls = Array.from(
      { length: role.min },
      (_, index) => `https://assets.example/reference-${index}.png`
    );
  if (entry.family === 'Flux.2') {
    values.aspectRatio = '1:1';
    values.resolution = '1K';
  }
  if (entry.publicModelId === 'z-image' && entry.workflow === 'text-to-image')
    values.aspectRatio = '1:1';
  return values;
}
