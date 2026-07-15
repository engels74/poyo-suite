import { IMAGE_REGISTRY_ENTRIES } from './image-registry';
export function imageCatalogue(query = '') {
  const needle = query.trim().toLowerCase();
  return IMAGE_REGISTRY_ENTRIES.filter(
    (entry) =>
      entry.status === 'current' &&
      (!needle ||
        [entry.displayName, entry.provider, entry.publicModelId, entry.workflow].some((value) =>
          value.toLowerCase().includes(needle)
        ))
  ).map((entry) => ({
    key: entry.key,
    displayName: entry.displayName,
    provider: entry.provider,
    family: entry.family,
    publicModelId: entry.publicModelId,
    workflow: entry.workflow,
    inputRoles: entry.inputRoles,
    output: entry.output,
    limitations: entry.limitations,
    documentation: entry.provenance.markdownUrl,
    verifiedAt: entry.provenance.verifiedAt,
    status: entry.status
  }));
}
