import { error } from '@sveltejs/kit';
import { LibraryRepository } from '$lib/server/library/repository';
import { nativeMediaCapabilities } from '$lib/server/media/native-actions';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const platform = await getPlatformServices();
  const job = await new LibraryRepository(platform.database).getJobDetail(params.jobId);
  if (!job) error(404, 'Job not found.');
  return { job, mediaCapabilities: nativeMediaCapabilities() };
};
