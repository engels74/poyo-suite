import { RequestSecurityError } from '../platform/request-security';
import { SourceIntakeError, SourceIntakePrerequisiteError } from '../media/source-intake';
import { PoyoError } from '../poyo/errors';
import { RegistryValidationError } from '../../features/registry/normalize';
import { JobRequestError } from './create-request';
export function jobHttpError(error: unknown): Response {
  if (error instanceof JobRequestError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  if (error instanceof RegistryValidationError)
    return Response.json(
      {
        error: { code: 'registry_validation_failed', message: error.message, issues: error.issues }
      },
      { status: 422 }
    );
  if (error instanceof RequestSecurityError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  if (error instanceof SourceIntakePrerequisiteError)
    return Response.json(
      { error: { code: error.code, message: error.message, tool: error.tool } },
      { status: error.status }
    );
  if (error instanceof SourceIntakeError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  if (error instanceof PoyoError)
    return Response.json(
      { error: error.toSafeDto() },
      { status: error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : 400 }
    );
  return Response.json(
    { error: { code: 'job_request_failed', message: 'The job request could not be completed.' } },
    { status: 400 }
  );
}
