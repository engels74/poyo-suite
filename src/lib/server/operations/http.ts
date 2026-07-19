import { CleanupValidationError } from '../cleanup/policy';
import { MaintenanceUnavailableError } from '../platform/maintenance-gate';
import { RequestSecurityError } from '../platform/request-security';
import { PoyoError } from '../poyo/errors';
import { CredentialBackendError, EnvironmentKeyActiveError } from '../settings/api-key-manager';
import { PublicIpv4ValidationError } from '../../features/settings/public-ipv4-guard';

export function operationsHttpError(error: unknown): Response {
  if (error instanceof PublicIpv4ValidationError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 });
  }
  if (error instanceof RequestSecurityError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  if (error instanceof CleanupValidationError) {
    return Response.json(
      { error: { code: 'cleanup_invalid', message: error.message } },
      { status: 400 }
    );
  }
  if (error instanceof MaintenanceUnavailableError) {
    return Response.json(
      {
        error: {
          code: 'maintenance_frozen',
          message: 'Local storage maintenance is already in progress.'
        }
      },
      { status: 503 }
    );
  }
  if (error instanceof EnvironmentKeyActiveError) {
    return Response.json(
      { error: { code: 'environment_key_active', message: error.message } },
      { status: 409 }
    );
  }
  if (error instanceof CredentialBackendError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 409 });
  }
  if (error instanceof PoyoError) {
    return Response.json(
      { error: error.toSafeDto() },
      { status: error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : 400 }
    );
  }
  return Response.json(
    {
      error: {
        code: 'operation_failed',
        message: 'The local operation could not be completed. Review redacted diagnostics.'
      }
    },
    { status: 400 }
  );
}
