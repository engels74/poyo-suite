import { IMAGE_PAGE_SLUGS, IMAGE_PUBLIC_IDS } from '../src/lib/features/registry/image-registry';
const index = await fetch('https://docs.poyo.ai/llms.txt').then((response) => {
  if (!response.ok) throw new Error(`Documentation index returned ${response.status}.`);
  return response.text();
});
const remotePages = [...index.matchAll(/image-series\/([^\s)]+)\.md/g)]
  .map((match) => match[1])
  .filter((value): value is string => Boolean(value));
const pageSet = new Set(remotePages);
const added = [...pageSet].filter((slug) => !IMAGE_PAGE_SLUGS.includes(slug));
const removed = IMAGE_PAGE_SLUGS.filter((slug) => !pageSet.has(slug));
const discoveredIds = [
  ...new Set(
    [...index.matchAll(/`([a-z0-9][a-z0-9./-]+)`/gi)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value))
  )
];
const unknownIds = discoveredIds.filter(
  (id) => !IMAGE_PUBLIC_IDS.includes(id) && !id.includes('video')
);
const report = {
  checkedAt: new Date().toISOString(),
  baseline: { pages: IMAGE_PAGE_SLUGS.length, publicIds: IMAGE_PUBLIC_IDS.length },
  addedPages: added,
  removedPages: removed,
  unclassifiedCandidateIds: unknownIds,
  classification: {
    removedPages: removed.length ? 'fail' : 'pass',
    addedPages: added.length ? 'warn' : 'pass',
    unknownIds: unknownIds.length ? 'warn' : 'pass'
  },
  note: 'Remote audit performs no generation and spends no credits. Field/enum/default/required conflicts require paired schema review.'
};
console.log(JSON.stringify(report, null, 2));
if (removed.length) process.exit(1);
