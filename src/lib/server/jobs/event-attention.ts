import { publicIpv4GuardReason, type PublicIpv4GuardReason } from '../poyo/errors';

export const JOB_EVENT_METADATA_KEY = '__poyoStudioEvent';

type DurableJobEventMetadata = {
  version: 1;
  attentionCode: string | null;
  payloadWasNull: boolean;
};

export type SafeJobEventAttention = {
  attentionCode: string | null;
  ipGuardReason: PublicIpv4GuardReason | null;
};

type SanitizedJobEventPayload = {
  payload: Record<string, unknown> | null;
  attention?: SafeJobEventAttention;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function durableMetadata(value: unknown): DurableJobEventMetadata | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1 || typeof value.payloadWasNull !== 'boolean') return null;
  if (value.attentionCode !== null && typeof value.attentionCode !== 'string') return null;
  return {
    version: 1,
    attentionCode: value.attentionCode,
    payloadWasNull: value.payloadWasNull
  };
}

export function safeJobEventAttention(attentionCode: string | null): SafeJobEventAttention {
  const ipGuardReason = publicIpv4GuardReason(attentionCode);
  return {
    attentionCode: ipGuardReason ? 'ip_guard_blocked' : attentionCode,
    ipGuardReason
  };
}

export function packDurableJobEventPayload(
  payload: Record<string, unknown> | null,
  attentionCode: string | null
): Record<string, unknown> {
  const publicPayload = payload ?? {};
  const { [JOB_EVENT_METADATA_KEY]: _reserved, ...nonReservedPayload } = publicPayload;
  return {
    ...nonReservedPayload,
    [JOB_EVENT_METADATA_KEY]: {
      version: 1,
      attentionCode,
      payloadWasNull: payload === null
    } satisfies DurableJobEventMetadata
  };
}

function sanitizePublicPayload(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  const reason = publicIpv4GuardReason(payload.code);
  if (!reason) return payload;
  const { code: _code, ...nonTechnicalPayload } = payload;
  return {
    ...nonTechnicalPayload,
    policy: 'ip_guard_blocked',
    reason
  };
}

export function sanitizeDurableJobEventPayload(payload: unknown): SanitizedJobEventPayload {
  if (!isRecord(payload)) return { payload: null };
  const hasMetadata = Object.hasOwn(payload, JOB_EVENT_METADATA_KEY);
  const { [JOB_EVENT_METADATA_KEY]: rawMetadata, ...nonReservedPayload } = payload;
  const metadata = durableMetadata(rawMetadata);
  const metadataIsConsistent =
    metadata !== null && (!metadata.payloadWasNull || Object.keys(nonReservedPayload).length === 0);
  const outwardPayload =
    metadataIsConsistent && metadata.payloadWasNull ? null : nonReservedPayload;
  const sanitized = sanitizePublicPayload(outwardPayload);

  if (!hasMetadata || !metadataIsConsistent || !metadata) return { payload: sanitized };
  return {
    payload: sanitized,
    attention: safeJobEventAttention(metadata.attentionCode)
  };
}
