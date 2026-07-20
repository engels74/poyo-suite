import { parseLibraryFilters } from '$lib/features/library/presentation';
import { LibraryRepository } from '$lib/server/library/repository';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const platform = await getPlatformServices();
  const repository = new LibraryRepository(platform.database);
  const filters = parseLibraryFilters(url.searchParams);
  return {
    filters,
    page: repository.listLibrary(filters),
    filterOptions: repository.filterOptions(),
    storage: await repository.storageStatistics(platform.paths)
  };
};
