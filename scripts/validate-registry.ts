import {
  IMAGE_PAGE_SLUGS,
  IMAGE_PUBLIC_IDS,
  IMAGE_REGISTRY
} from '../src/lib/features/registry/image-registry';
import { minimumValidRequest, normalizeImageRequest } from '../src/lib/features/registry/normalize';

const errors: string[] = [];
const keys = new Set<string>();
for (const entry of IMAGE_REGISTRY.entries) {
  if (keys.has(entry.key)) errors.push(`duplicate key ${entry.key}`);
  keys.add(entry.key);
  if (!entry.provenance.markdownUrl || entry.provenance.sourceHash.length !== 64)
    errors.push(`missing provenance ${entry.key}`);
  try {
    const preview = normalizeImageRequest(entry.key, minimumValidRequest(entry));
    if (preview.request.model !== entry.publicModelId)
      errors.push(`adapter model mismatch ${entry.key}`);
  } catch (error) {
    errors.push(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (IMAGE_PAGE_SLUGS.length !== 22)
  errors.push(`expected 22 image pages, found ${IMAGE_PAGE_SLUGS.length}`);
if (IMAGE_PUBLIC_IDS.length !== 44)
  errors.push(`expected 44 public image IDs, found ${IMAGE_PUBLIC_IDS.length}`);
if (IMAGE_REGISTRY.sourceHash.length !== 64 || IMAGE_REGISTRY.manifestHash.length !== 64)
  errors.push('registry hashes are invalid');
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(
  `Image registry valid: ${IMAGE_REGISTRY.pageCount} pages, ${IMAGE_REGISTRY.publicIdCount} public IDs, ${IMAGE_REGISTRY.entries.length} workflow variants, ${IMAGE_REGISTRY.manifestHash}.`
);
