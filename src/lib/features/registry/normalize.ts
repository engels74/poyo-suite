import { IMAGE_REGISTRY_ENTRIES } from './image-registry';
import {
  fieldValue,
  isExpertOverride,
  isStrictJsonValue,
  validateFieldValue
} from './runtime-validation';
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
  const runtimeValues = values as Record<string, unknown>;
  const acceptedFields = new Set(
    entry.fields.filter((field) => field.kind !== 'dimensions').map((field) => field.key)
  );
  if (entry.fields.some((field) => field.kind === 'dimensions')) {
    acceptedFields.add('width');
    acceptedFields.add('height');
  }
  if (entry.inputRoles.some((role) => role.role === 'reference')) acceptedFields.add('imageUrls');
  if (entry.inputRoles.some((role) => role.role === 'mask')) acceptedFields.add('maskUrl');
  for (const key of Object.keys(runtimeValues))
    if (!acceptedFields.has(key)) issues.push(`${key} is not supported for this workflow.`);
  for (const field of entry.fields) {
    if (field.kind === 'dimensions') continue;
    issues.push(...validateFieldValue(field, fieldValue(runtimeValues, field)));
  }
  if (
    values.imageUrls !== undefined &&
    (!Array.isArray(values.imageUrls) ||
      !values.imageUrls.every((value) => typeof value === 'string'))
  )
    issues.push('imageUrls must be a list of strings.');
  if (values.maskUrl !== undefined && typeof values.maskUrl !== 'string')
    issues.push('maskUrl must be a string.');
  const refs = Array.isArray(values.imageUrls) ? values.imageUrls.length : 0;
  for (const role of entry.inputRoles) {
    const count = role.role === 'mask' ? (typeof values.maskUrl === 'string' ? 1 : 0) : refs;
    if (role.required && count < role.min)
      issues.push(
        role.role === 'reference'
          ? `At least ${role.min} reference image is required.`
          : `At least ${role.min} ${role.role} input is required.`
      );
    if (role.max !== null && count > role.max)
      issues.push(
        role.role === 'reference'
          ? `At most ${role.max} reference images are supported.`
          : `At most ${role.max} ${role.role} inputs are supported.`
      );
  }
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
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new RegistryValidationError(['Guided values must be an object.']);
  if (!Array.isArray(overrides) || !overrides.every(isExpertOverride))
    throw new RegistryValidationError(['Expert overrides must contain key/value objects.']);
  const issues = validate(entry, values);
  if (issues.length) throw new RegistryValidationError(issues);
  const input: Record<string, unknown> = {};
  const runtimeValues = values as Record<string, unknown>;
  for (const field of entry.fields) {
    const value = fieldValue(runtimeValues, field);
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
    if (!isStrictJsonValue(override.value))
      throw new RegistryValidationError([`Expert override ${override.key} must be strict JSON.`]);
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
