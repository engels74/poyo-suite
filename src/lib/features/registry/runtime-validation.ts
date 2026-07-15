import type { ExpertOverride, FieldDefinition } from './types';

export function fieldValue(
  values: Readonly<Record<string, unknown>>,
  field: FieldDefinition
): unknown {
  return Object.hasOwn(values, field.key) ? values[field.key] : field.default;
}

function enumType(field: FieldDefinition): 'number' | 'string' {
  return typeof field.default === 'number' ? 'number' : 'string';
}

function objectList(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
  );
}

export function validateFieldValue(field: FieldDefinition, value: unknown): string[] {
  const issues: string[] = [];
  if (
    field.required &&
    (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
  )
    issues.push(`${field.key} is required.`);
  if (value === undefined) return issues;

  if (field.kind === 'text' && typeof value !== 'string')
    return [...issues, `${field.key} must be a string.`];
  if (field.kind === 'number' && typeof value !== 'number')
    return [...issues, `${field.key} must be a number.`];
  if (field.kind === 'integer' && typeof value !== 'number')
    return [...issues, `${field.key} must be an integer.`];
  if (field.kind === 'boolean' && typeof value !== 'boolean')
    return [...issues, `${field.key} must be boolean.`];
  if (field.kind === 'enum' && typeof value !== enumType(field))
    return [...issues, `${field.key} must be a ${enumType(field)}.`];
  if (field.kind === 'string-list') {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
      return [...issues, `${field.key} must be a list of strings.`];
  }
  if (field.kind === 'object-list' || field.kind === 'elements') {
    if (!Array.isArray(value)) return [...issues, `${field.key} must be a list.`];
    if (!objectList(value)) return [...issues, `${field.key} must contain objects.`];
    if (!isStrictJsonValue(value))
      return [...issues, `${field.key} must contain strict JSON objects.`];
  }
  if (field.kind === 'dimensions')
    return [...issues, `${field.key} is not supported as a direct value.`];

  if (typeof value === 'string') {
    if (field.min !== undefined && value.length < field.min)
      issues.push(`${field.key} is too short.`);
    if (field.max !== undefined && value.length > field.max)
      issues.push(`${field.key} is too long.`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return [...issues, `${field.key} must be finite.`];
    if (field.kind === 'integer' && !Number.isInteger(value))
      return [...issues, `${field.key} must be an integer.`];
    if (
      field.kind === 'enum' &&
      field.enum?.every((candidate) => /^-?\d+$/.test(candidate)) &&
      !Number.isInteger(value)
    )
      return [...issues, `${field.key} must be an integer.`];
    if (field.min !== undefined && value < field.min) issues.push(`${field.key} is below minimum.`);
    if (field.max !== undefined && value > field.max) issues.push(`${field.key} exceeds maximum.`);
  }
  if (field.enum && !field.enum.includes(String(value)))
    issues.push(`${field.key} is unsupported.`);
  if (Array.isArray(value)) {
    if (field.min !== undefined && value.length < field.min)
      issues.push(`${field.key} has too few items.`);
    if (field.max !== undefined && value.length > field.max)
      issues.push(`${field.key} has too many items.`);
  }
  return issues;
}

export function isStrictJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isStrictJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isStrictJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function isExpertOverride(value: unknown): value is ExpertOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).every((key) => key === 'key' || key === 'value') &&
    typeof candidate.key === 'string' &&
    Object.hasOwn(candidate, 'value')
  );
}
