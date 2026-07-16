import type {
  FieldDefinition,
  ImageRegistryEntry,
  ImageWorkflow,
  RegistryAuditRecord,
  RegistryManifest,
  RegistryProvenance
} from './types';
import { OFFICIAL_SOURCE_MANIFEST, officialModelSources } from './evidence/source-evidence';

export const IMAGE_REGISTRY_VERSION = 'image-2026-07-15.3';
export const IMAGE_VERIFIED_AT = OFFICIAL_SOURCE_MANIFEST.verifiedAt;
const ratios8 = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', 'auto'];
const seedreamRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const ratios10 = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const formats = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const prompt = (min = 1, max = 5000): FieldDefinition => ({
  key: 'prompt',
  apiKey: 'prompt',
  kind: 'text',
  level: 'essential',
  required: true,
  min,
  max
});
const refs = (required: boolean, min: number, max: number | null) => ({
  role: 'reference' as const,
  required,
  min,
  max,
  mediaKind: 'image' as const,
  formats
});
const mask = {
  role: 'mask' as const,
  required: false,
  min: 0,
  max: 1,
  mediaKind: 'image' as const,
  formats
};
type Page = {
  slug: string;
  provider: string;
  family: string;
  ids: string[];
  prompt?: [number, number];
  ratios?: string[];
  res?: string[];
  n?: [number, number | null] | null;
  formats?: string[];
  formatDefault?: string;
  ratioDefault?: string;
  resDefault?: string;
  refs?: [number, number | null];
  optionalRefs?: [number, number | null];
  custom?:
    | boolean
    | {
        encoding: 'object' | 'width-x-height-string';
        divisor?: number;
        maxEdge?: number;
        minPixels?: number;
        maxPixels?: number;
        maxAspectRatio?: number;
      };
  seed?: boolean;
  safety?: boolean;
  extra?: FieldDefinition[];
  limitations?: string[];
};
const pages: Page[] = [
  {
    slug: 'flux-2',
    provider: 'Black Forest Labs',
    family: 'Flux.2',
    ids: ['flux-2-pro', 'flux-2-pro-edit', 'flux-2-flex', 'flux-2-flex-edit'],
    prompt: [3, 5000],
    ratios: ratios8,
    res: ['1K', '2K'],
    refs: [1, 8],
    limitations: ['Size and resolution are both required.']
  },
  {
    slug: 'flux-dev',
    provider: 'Black Forest Labs',
    family: 'Flux Dev',
    ids: ['flux-dev'],
    ratios: ['1:1', '1:1 HD', '4:3', '3:4', '16:9', '9:16'],
    optionalRefs: [0, 1],
    n: [1, null],
    formats: ['jpeg', 'png'],
    ratioDefault: '1:1',
    formatDefault: 'png',
    custom: { encoding: 'width-x-height-string' }
  },
  {
    slug: 'flux-kontext',
    provider: 'Black Forest Labs',
    family: 'Flux Kontext',
    ids: ['flux-kontext-pro', 'flux-kontext-pro-edit', 'flux-kontext-max', 'flux-kontext-max-edit'],
    prompt: [1, 2000],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'],
    refs: [1, 1],
    formats: ['png', 'jpg'],
    limitations: ['Edit variants use only reference image index 0.']
  },
  {
    slug: 'flux-schnell',
    provider: 'Black Forest Labs',
    family: 'Flux Schnell',
    ids: ['flux-schnell'],
    ratios: ['1:1', '1:1 HD', '4:3', '3:4', '16:9', '9:16'],
    n: [1, null],
    formats: ['jpeg', 'png'],
    ratioDefault: '1:1',
    formatDefault: 'png',
    custom: { encoding: 'width-x-height-string' }
  },
  {
    slug: 'gpt-4o-image',
    provider: 'OpenAI',
    family: 'GPT-4o Image',
    ids: ['gpt-4o-image', 'gpt-4o-image-edit'],
    prompt: [1, 1000],
    ratios: ['1:1', '2:3', '3:2'],
    n: [1, 4],
    refs: [1, null],
    extra: [{ key: 'maskUrl', apiKey: 'mask_url', kind: 'text', level: 'advanced' }]
  },
  {
    slug: 'gpt-image-1.5',
    provider: 'OpenAI',
    family: 'GPT Image 1.5',
    ids: ['gpt-image-1.5', 'gpt-image-1.5-edit'],
    prompt: [1, 1000],
    ratios: ['1:1', '2:3', '3:2'],
    n: [1, 4],
    refs: [1, null],
    extra: [{ key: 'maskUrl', apiKey: 'mask_url', kind: 'text', level: 'advanced' }]
  },
  {
    slug: 'gpt-image-2',
    provider: 'OpenAI',
    family: 'GPT Image 2',
    ids: ['gpt-image-2', 'gpt-image-2-edit'],
    prompt: [1, 20000],
    ratios: ['auto', '1:1', '2:3', '3:2', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'],
    res: ['1K', '2K', '4K'],
    refs: [1, null],
    custom: {
      encoding: 'width-x-height-string',
      divisor: 16,
      maxEdge: 3840,
      minPixels: 655360,
      maxPixels: 8294400,
      maxAspectRatio: 3
    },
    extra: [
      {
        key: 'quality',
        apiKey: 'quality',
        kind: 'enum',
        level: 'common',
        default: 'low',
        enum: ['low', 'medium', 'high']
      }
    ]
  },
  {
    slug: 'grok-imagine-image',
    provider: 'xAI',
    family: 'Grok Imagine Image',
    ids: ['grok-imagine-image'],
    prompt: [1, 5000],
    ratios: ['1:1', '2:3', '3:2', '9:16', '16:9'],
    optionalRefs: [0, 1]
  },
  {
    slug: 'grok-imagine-image-quality',
    provider: 'xAI',
    family: 'Grok Imagine Image Quality',
    ids: ['grok-imagine-image-quality'],
    ratios: ['1:1', '2:3', '3:2', '9:16', '16:9'],
    res: ['1K', '2K'],
    optionalRefs: [0, 3],
    n: [1, null],
    formats: ['png', 'jpeg', 'jpg', 'webp'],
    extra: [
      { key: 'syncMode', apiKey: 'sync_mode', kind: 'boolean', level: 'advanced', default: false }
    ]
  },
  {
    slug: 'kling-o1',
    provider: 'Kuaishou',
    family: 'Kling O1',
    ids: ['kling-o1-image-edit'],
    refs: [1, 10],
    ratios: ratios8,
    res: ['1K', '2K'],
    n: [1, 9],
    formats: ['jpeg', 'png', 'webp'],
    extra: [{ key: 'elements', apiKey: 'elements', kind: 'elements', level: 'advanced' }]
  },
  {
    slug: 'kling-o3',
    provider: 'Kuaishou',
    family: 'Kling O3 Image',
    ids: ['kling-o3-image', 'kling-o3-image-edit'],
    refs: [1, 10],
    ratios: ratios8,
    res: ['1K', '2K', '4K'],
    n: [1, 9],
    formats: ['jpeg', 'png', 'webp'],
    extra: [{ key: 'elements', apiKey: 'elements', kind: 'elements', level: 'advanced' }],
    limitations: ['Elements remain a reviewed structured adapter surface.']
  },
  {
    slug: 'nano-banana',
    provider: 'Google',
    family: 'Nano Banana',
    ids: ['nano-banana', 'nano-banana-edit'],
    prompt: [1, 5000],
    ratios: ratios10,
    refs: [1, null]
  },
  {
    slug: 'nano-banana-2',
    provider: 'Google',
    family: 'Nano Banana 2 / Pro',
    ids: ['nano-banana-2', 'nano-banana-2-edit', 'nano-banana-pro', 'nano-banana-pro-edit'],
    prompt: [1, 10000],
    ratios: ['auto', ...ratios10],
    res: ['1K', '2K', '4K'],
    n: [1, 1],
    refs: [1, 14],
    formats: ['png', 'jpg', 'jpeg', 'webp'],
    extra: [
      { key: 'webSearch', apiKey: 'web_search', kind: 'boolean', level: 'advanced', default: false }
    ],
    limitations: ['Output format and web search are Pro-only.']
  },
  {
    slug: 'nano-banana-2-lite',
    provider: 'Google',
    family: 'Nano Banana 2 Lite',
    ids: ['nano-banana-2-lite', 'nano-banana-2-lite-edit'],
    ratios: ratios10,
    refs: [1, 14],
    limitations: ['Text variant forbids image_urls.']
  },
  {
    slug: 'nano-banana-2-new',
    provider: 'Google',
    family: 'Nano Banana 2 New / Official',
    ids: [
      'nano-banana-2-new',
      'nano-banana-2-new-edit',
      'nano-banana-2-official',
      'nano-banana-2-official-edit'
    ],
    prompt: [1, 20000],
    ratios: ['auto', ...ratios10, '1:4', '4:1', '1:8', '8:1'],
    res: ['0.5K', '1K', '2K', '4K'],
    refs: [1, 14],
    formats: ['png', 'jpg', 'jpeg', 'webp'],
    seed: true,
    extra: [
      {
        key: 'googleSearch',
        apiKey: 'google_search',
        kind: 'boolean',
        level: 'advanced',
        default: false
      }
    ],
    limitations: ['Some seed fields are official-variant only.']
  },
  {
    slug: 'seedream-4',
    provider: 'ByteDance',
    family: 'Seedream 4',
    ids: ['seedream-4', 'seedream-4-edit'],
    ratios: seedreamRatios,
    res: ['1K', '2K', '4K'],
    refs: [1, 10],
    n: [1, 15],
    limitations: ['image_urls plus n must not exceed 15.']
  },
  {
    slug: 'seedream-4-5',
    provider: 'ByteDance',
    family: 'Seedream 4.5',
    ids: ['seedream-4.5', 'seedream-4.5-edit'],
    prompt: [1, 3000],
    ratios: seedreamRatios,
    res: ['2K', '4K'],
    refs: [1, 10],
    n: [1, 15],
    custom: { encoding: 'object' },
    safety: true
  },
  {
    slug: 'seedream-5-0-lite',
    provider: 'ByteDance',
    family: 'Seedream 5.0 Lite',
    ids: ['seedream-5.0-lite', 'seedream-5.0-lite-edit'],
    prompt: [3, 3000],
    ratios: seedreamRatios,
    res: ['2K', '3K'],
    refs: [1, 10],
    n: [1, 15],
    custom: { encoding: 'object' },
    safety: true
  },
  {
    slug: 'seedream-5-0-pro',
    provider: 'ByteDance',
    family: 'Seedream 5.0 Pro',
    ids: ['seedream-5.0-pro', 'seedream-5.0-pro-edit'],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    ratioDefault: '1:1',
    res: ['1K', '2K'],
    resDefault: '2K',
    refs: [1, 10],
    formats: ['jpeg', 'png'],
    safety: true
  },
  {
    slug: 'wan-2-7-image',
    provider: 'Alibaba',
    family: 'Wan 2.7 Image',
    ids: ['wan-2.7-image'],
    prompt: [1, 5000],
    ratios: ['512x512', '1024x1024', '768x1024', '1024x768', '576x1024', '1024x576'],
    optionalRefs: [0, 4],
    n: [1, 4],
    custom: { encoding: 'object' },
    seed: true
  },
  {
    slug: 'wan-2-7-image-pro',
    provider: 'Alibaba',
    family: 'Wan 2.7 Image Pro',
    ids: ['wan-2.7-image-pro'],
    prompt: [1, 5000],
    ratios: ['512x512', '1024x1024', '768x1024', '1024x768', '576x1024', '1024x576'],
    optionalRefs: [0, 4],
    n: [1, 4],
    custom: { encoding: 'object' },
    seed: true
  },
  {
    slug: 'z-image',
    provider: 'Alibaba',
    family: 'Z-Image',
    ids: ['z-image'],
    prompt: [1, 1000],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    optionalRefs: [0, 1],
    safety: true,
    limitations: ['Size is required for text generation and optional for edit.']
  }
];
function workflow(mode: 'base' | 'edit'): ImageWorkflow {
  return mode === 'edit' ? 'image-edit' : 'text-to-image';
}
function provenance(page: Page): RegistryProvenance {
  const sources = officialModelSources('image', page.slug);
  return {
    pageSlug: page.slug,
    markdownUrl: sources.markdown.url,
    markdownSha256: sources.markdown.sha256,
    jsonUrl: sources.json.url,
    jsonStatus: sources.json.status,
    jsonSha256: sources.json.sha256,
    sourceManifestVersion: `${OFFICIAL_SOURCE_MANIFEST.version}:${OFFICIAL_SOURCE_MANIFEST.corpusSha256}`,
    verifiedAt: IMAGE_VERIFIED_AT
  };
}
function entry(page: Page, id: string, mode: 'base' | 'edit'): ImageRegistryEntry {
  const isEdit = mode === 'edit';
  const supportsSeed =
    Boolean(page.seed) && (page.slug !== 'nano-banana-2-new' || id.includes('official'));
  const isNanoBananaPro = page.family === 'Nano Banana 2 / Pro' && id.includes('pro');
  const supportsOutputFormat = page.family !== 'Nano Banana 2 / Pro' || isNanoBananaPro;
  const effectiveFormats = supportsOutputFormat ? page.formats : undefined;
  const effectiveRatios =
    page.family === 'Kling O3 Image' && !isEdit
      ? page.ratios?.filter((ratio) => ratio !== 'auto')
      : page.ratios;
  const unionSize = ['Seedream 4.5', 'Seedream 5.0 Lite'].includes(page.family);
  const fields: FieldDefinition[] = [
    prompt(...(page.prompt ?? [1, 5000])),
    ...(effectiveRatios
      ? [
          {
            key: 'aspectRatio',
            apiKey: 'size',
            kind: 'enum' as const,
            level: 'common' as const,
            enum: effectiveRatios,
            ...(page.ratioDefault ? { default: page.ratioDefault } : {})
          }
        ]
      : []),
    ...(page.res
      ? [
          {
            key: 'resolution',
            apiKey: unionSize ? 'size' : 'resolution',
            kind: 'enum' as const,
            level: 'common' as const,
            enum: page.res,
            ...(page.resDefault ? { default: page.resDefault } : {})
          }
        ]
      : []),
    ...(page.n
      ? [
          {
            key: 'n',
            apiKey: 'n',
            kind: 'integer' as const,
            level: 'common' as const,
            default: 1,
            min: page.n[0],
            ...(page.n[1] === null ? {} : { max: page.n[1] })
          }
        ]
      : []),
    ...(effectiveFormats
      ? [
          {
            key: 'outputFormat',
            apiKey: 'output_format',
            kind: 'enum' as const,
            level: 'common' as const,
            enum: effectiveFormats,
            ...(page.formatDefault ? { default: page.formatDefault } : {})
          }
        ]
      : []),
    ...(page.custom
      ? [
          {
            key: 'dimensions',
            apiKey: 'size',
            kind: 'dimensions' as const,
            level: 'advanced' as const
          }
        ]
      : []),
    ...(supportsSeed
      ? [
          {
            key: 'seed',
            apiKey: 'seed',
            kind: 'integer' as const,
            level: 'advanced' as const,
            min: 0,
            max: 2147483647
          }
        ]
      : []),
    ...(page.safety
      ? [
          {
            key: 'enableSafetyChecker',
            apiKey: 'enable_safety_checker',
            kind: 'boolean' as const,
            level: 'common' as const,
            default: false
          }
        ]
      : []),
    ...(page.extra ?? []).filter(
      (field) =>
        field.key !== 'webSearch' || page.family !== 'Nano Banana 2 / Pro' || isNanoBananaPro
    )
  ];
  const refSpec = isEdit ? (page.refs ?? page.optionalRefs) : page.optionalRefs;
  const countRange = page.n;
  const counts =
    countRange && countRange[1] !== null
      ? Array.from(
          { length: countRange[1] - countRange[0] + 1 },
          (_, index) => index + countRange[0]
        )
      : null;
  const customDimensions = typeof page.custom === 'object' ? page.custom : undefined;
  const conditionalRules = [
    ...(unionSize ? ['size-is-one-of-resolution-ratio-or-custom'] : []),
    ...(page.family === 'Flux.2' ? ['size-and-resolution-required'] : []),
    ...(page.family === 'Seedream 4' ? ['reference-count-plus-output-count-at-most-15'] : []),
    ...(id === 'z-image' ? ['size-required-for-text-only'] : []),
    ...(page.family === 'Nano Banana 2 / Pro' ? ['pro-only-output-format-and-web-search'] : [])
  ];
  return {
    key: `${id}:${workflow(mode)}`,
    provider: page.provider,
    family: page.family,
    displayName: `${page.family}${isEdit ? ' Edit' : ''}`,
    publicModelId: id,
    workflow: workflow(mode),
    status: 'current',
    inputRoles: [
      ...(refSpec ? [refs(isEdit, refSpec[0], refSpec[1])] : []),
      ...(id.includes('gpt-') && isEdit ? [mask] : [])
    ],
    output: {
      mediaKind: 'image',
      formats: effectiveFormats ?? ['png'],
      counts,
      customSize: Boolean(page.custom),
      seed: supportsSeed,
      safetyChecker: page.safety ?? false
    },
    fields,
    ui: { form: 'guided-image', fieldOrder: fields.map((field) => field.key) },
    validation: {
      conditionalRules,
      ...(customDimensions
        ? {
            customDimensions: {
              ...(customDimensions.divisor ? { divisor: customDimensions.divisor } : {}),
              ...(customDimensions.maxEdge ? { maxEdge: customDimensions.maxEdge } : {}),
              ...(customDimensions.minPixels ? { minPixels: customDimensions.minPixels } : {}),
              ...(customDimensions.maxPixels ? { maxPixels: customDimensions.maxPixels } : {}),
              ...(customDimensions.maxAspectRatio
                ? { maxAspectRatio: customDimensions.maxAspectRatio }
                : {})
            }
          }
        : {})
    },
    payload: {
      adapter: 'image-input-v1',
      ...(customDimensions ? { dimensionsEncoding: customDimensions.encoding } : {})
    },
    response: { normalizer: 'poyo-task-image-v1', mediaKind: 'image' },
    limitations: page.limitations ?? [],
    provenance: provenance(page)
  };
}
export const IMAGE_REGISTRY_ENTRIES: readonly ImageRegistryEntry[] = pages.flatMap((page) =>
  page.ids.flatMap((id) => {
    const explicitEdit = id.endsWith('-edit');
    if (explicitEdit) return [entry(page, id, 'edit')];
    const hasEditId = page.ids.includes(`${id}-edit`);
    const switches = Boolean(page.optionalRefs);
    return hasEditId
      ? [entry(page, id, 'base')]
      : switches
        ? [entry(page, id, 'base'), entry(page, id, 'edit')]
        : [entry(page, id, 'base')];
  })
);
export const IMAGE_PAGE_SLUGS = pages.map((page) => page.slug);
export const IMAGE_PUBLIC_IDS = [
  ...new Set(IMAGE_REGISTRY_ENTRIES.map((item) => item.publicModelId))
];
export const IMAGE_AUDIT_RECORDS: readonly RegistryAuditRecord[] = [
  {
    key: 'unindexed:openapi-gpt4o',
    publicModelIds: ['gpt-4o-image', 'gpt-4o-image-edit'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/openapi-gpt4o.json',
    reason: 'Top-level duplicate OpenAPI is not a current Markdown catalogue page.'
  },
  {
    key: 'unindexed:openapi-nano-banana',
    publicModelIds: ['nano-banana', 'nano-banana-edit'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/openapi-nano-banana.json',
    reason: 'Top-level duplicate OpenAPI is retained outside normal selectors.'
  }
];
const manifestMaterial = JSON.stringify({
  entries: IMAGE_REGISTRY_ENTRIES,
  audit: IMAGE_AUDIT_RECORDS
});
export const IMAGE_REGISTRY: RegistryManifest = {
  version: IMAGE_REGISTRY_VERSION,
  verifiedAt: IMAGE_VERIFIED_AT,
  pageCount: IMAGE_PAGE_SLUGS.length,
  publicIdCount: IMAGE_PUBLIC_IDS.length,
  entries: IMAGE_REGISTRY_ENTRIES,
  sourceCorpusHash: OFFICIAL_SOURCE_MANIFEST.corpusSha256,
  manifestHash: new Bun.CryptoHasher('sha256').update(manifestMaterial).digest('hex')
};
