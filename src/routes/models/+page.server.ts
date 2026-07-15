import { imageCatalogue } from '$lib/features/registry/catalogue';
import { IMAGE_REGISTRY } from '$lib/features/registry/image-registry';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ url }) => ({
  registry: {
    version: IMAGE_REGISTRY.version,
    verifiedAt: IMAGE_REGISTRY.verifiedAt,
    pageCount: IMAGE_REGISTRY.pageCount,
    publicIdCount: IMAGE_REGISTRY.publicIdCount
  },
  models: imageCatalogue(url.searchParams.get('q') ?? '')
});
