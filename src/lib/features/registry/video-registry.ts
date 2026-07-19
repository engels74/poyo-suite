import { OFFICIAL_SOURCE_MANIFEST, officialModelSources } from './evidence/source-evidence';
import type {
  FieldDefinition,
  GuidedVideoRequest,
  InputRole,
  RegistryAuditRecord,
  RegistryManifest,
  RegistryProvenance,
  VideoRegistryEntry,
  VideoWorkflow
} from './types';

export const VIDEO_REGISTRY_VERSION = 'video-2026-07-19.1';
export const VIDEO_VERIFIED_AT = OFFICIAL_SOURCE_MANIFEST.verifiedAt;
const videoFormats = ['video/mp4', 'video/webm', 'video/quicktime'];
const imageFormats = ['image/jpeg', 'image/png', 'image/webp'];
const audioFormats = ['audio/mpeg', 'audio/wav', 'audio/mp4'];

type Model = { id: string; workflows: VideoWorkflow[] };
type Page = {
  slug: string;
  provider: string;
  family: string;
  models: Model[];
  prompt?: [number, number];
  durations?: readonly number[] | { min: number; max: number };
  durationDefault?: number;
  ratios?: readonly string[];
  ratioDefault?: string;
  resolutions?: readonly string[];
  resolutionDefault?: string;
  mode?: readonly string[];
  negativePrompt?: boolean;
  cfgScale?: boolean;
  promptOptimizer?: boolean;
  seed?: boolean;
  safety?: boolean;
  fixedLens?: boolean;
  generateAudio?: boolean;
  sound?: boolean;
  audio?: 'string' | 'setting';
  multiShots?: boolean;
  elements?: boolean;
  orientation?: boolean;
  limitations?: string[];
};

const ratiosFive = ['1:1', '2:3', '3:2', '16:9', '9:16'];
const ratiosThree = ['1:1', '16:9', '9:16'];
const ratiosSix = ['1:1', '21:9', '4:3', '3:4', '16:9', '9:16'];
const seedanceRatios = ['auto', ...ratiosSix];
const textImage: VideoWorkflow[] = ['text-to-video', 'image-to-video'];
const klingRich: VideoWorkflow[] = [
  'text-to-video',
  'frame-to-video',
  'reference-to-video',
  'multi-shot-video'
];

const pages: Page[] = [
  {
    slug: 'grok-imagine',
    provider: 'xAI',
    family: 'Grok Imagine Video',
    models: [{ id: 'grok-imagine', workflows: textImage }],
    ratios: ratiosFive,
    durations: [6, 10],
    mode: ['fun', 'normal', 'spicy']
  },
  {
    slug: 'grok-imagine-video-1-5',
    provider: 'xAI',
    family: 'Grok Imagine Video 1.5',
    models: [{ id: 'grok-imagine-video-1.5', workflows: ['image-to-video'] }],
    prompt: [1, 4096],
    resolutions: ['480p', '720p'],
    resolutionDefault: '720p',
    durations: { min: 1, max: 15 },
    durationDefault: 6
  },
  {
    slug: 'hailuo-02',
    provider: 'MiniMax',
    family: 'Hailuo 02',
    models: [
      { id: 'hailuo-02', workflows: ['text-to-video', 'image-to-video', 'frame-to-video'] },
      { id: 'hailuo-02-pro', workflows: textImage }
    ],
    durations: [6, 10],
    resolutions: ['512P', '768P'],
    promptOptimizer: true,
    limitations: [
      'The standard end-frame workflow requires 768P; Pro is fixed to 1080P and 6 seconds.'
    ]
  },
  {
    slug: 'hailuo-2-3',
    provider: 'MiniMax',
    family: 'Hailuo 2.3',
    models: [{ id: 'hailuo-2.3', workflows: textImage }],
    durations: [6, 10],
    durationDefault: 6,
    resolutions: ['768p', '1080p'],
    resolutionDefault: '768p',
    promptOptimizer: true,
    limitations: ['1080p supports 6 seconds only; end frames are not supported.']
  },
  {
    slug: 'happy-horse-1-1',
    provider: 'Alibaba',
    family: 'Happy Horse 1.1',
    models: [
      {
        id: 'happy-horse-1.1',
        workflows: ['text-to-video', 'image-to-video', 'reference-to-video']
      }
    ],
    durations: { min: 3, max: 15 },
    durationDefault: 5,
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '4:5', '5:4', '9:16', '9:21'],
    ratioDefault: '16:9',
    resolutions: ['720p', '1080p'],
    resolutionDefault: '1080p',
    seed: true,
    safety: true,
    limitations: ['Image input and reference-image input modes are mutually exclusive.']
  },
  {
    slug: 'happy-horse',
    provider: 'Alibaba',
    family: 'Happy Horse',
    models: [
      {
        id: 'happy-horse',
        workflows: ['text-to-video', 'image-to-video', 'reference-to-video', 'video-edit']
      }
    ],
    durations: { min: 3, max: 15 },
    durationDefault: 5,
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    ratioDefault: '16:9',
    resolutions: ['720p', '1080p'],
    resolutionDefault: '1080p',
    seed: true,
    safety: true,
    audio: 'setting',
    limitations: [
      'Video edit accepts a 3–60 second source, processes at most 15 seconds, and ignores output duration.'
    ]
  },
  {
    slug: 'kling-1-6',
    provider: 'Kuaishou',
    family: 'Kling 1.6',
    models: [
      {
        id: 'kling-1.6/standard',
        workflows: ['text-to-video', 'image-to-video', 'reference-to-video']
      },
      {
        id: 'kling-1.6/pro',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video', 'reference-to-video']
      }
    ],
    durations: [5, 10],
    ratios: ratiosThree,
    negativePrompt: true,
    cfgScale: true,
    elements: true,
    limitations: [
      'Elements, start/end frames, and cfg controls have documented conflicts; end frame is Pro-only.'
    ]
  },
  {
    slug: 'kling-2-1',
    provider: 'Kuaishou',
    family: 'Kling 2.1',
    models: [
      { id: 'kling-2.1/standard', workflows: ['image-to-video'] },
      { id: 'kling-2.1/pro', workflows: ['image-to-video', 'frame-to-video'] }
    ],
    durations: [5, 10],
    durationDefault: 5,
    negativePrompt: true,
    limitations: ['A start frame is required; end frame is Pro-only.']
  },
  {
    slug: 'kling-2-5-turbo-pro',
    provider: 'Kuaishou',
    family: 'Kling 2.5 Turbo Pro',
    models: [
      {
        id: 'kling-2.5-turbo-pro',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video']
      }
    ],
    durations: [5, 10],
    durationDefault: 5,
    ratios: ratiosThree,
    negativePrompt: true
  },
  {
    slug: 'kling-2-6',
    provider: 'Kuaishou',
    family: 'Kling 2.6',
    models: [{ id: 'kling-2.6', workflows: ['text-to-video', 'image-to-video', 'frame-to-video'] }],
    durations: [5, 10],
    ratios: ratiosThree,
    sound: true,
    limitations: ['Sound is required and must be false when an end frame is supplied.']
  },
  {
    slug: 'kling-2.6-motion-control',
    provider: 'Kuaishou',
    family: 'Kling 2.6 Motion Control',
    models: [{ id: 'kling-2.6-motion-control', workflows: ['motion-control'] }],
    resolutions: ['720p', '1080p'],
    orientation: true,
    limitations: [
      'Image orientation supports reference videos through 10s; video orientation supports 3–30s.'
    ]
  },
  {
    slug: 'kling-3-0',
    provider: 'Kuaishou',
    family: 'Kling 3.0',
    models: [
      { id: 'kling-3.0/standard', workflows: klingRich },
      { id: 'kling-3.0/pro', workflows: klingRich }
    ],
    durations: { min: 3, max: 15 },
    ratios: ratiosThree,
    sound: true,
    elements: true,
    limitations: ['Prompt and multi_prompt are exclusive; multi-shot requires sound=true.']
  },
  {
    slug: 'kling-3-0-4k',
    provider: 'Kuaishou',
    family: 'Kling 3.0 4K',
    models: [{ id: 'kling-3.0/4K', workflows: klingRich }],
    durations: { min: 3, max: 15 },
    ratios: ratiosThree,
    sound: true,
    elements: true,
    limitations: ['Prompt and multi_prompt are exclusive; multi-shot requires sound=true.']
  },
  {
    slug: 'kling-3-0-turbo',
    provider: 'Kuaishou',
    family: 'Kling 3.0 Turbo',
    models: [
      {
        id: 'kling-3.0-turbo/standard',
        workflows: ['text-to-video', 'image-to-video', 'multi-shot-video']
      },
      {
        id: 'kling-3.0-turbo/pro',
        workflows: ['text-to-video', 'image-to-video', 'multi-shot-video']
      }
    ],
    durations: { min: 3, max: 15 },
    durationDefault: 5,
    ratios: ['16:9', '9:16', '1:1'],
    ratioDefault: '16:9',
    limitations: ['multi_prompt contains 1–6 shots and total shot duration must equal duration.']
  },
  {
    slug: 'kling-3-0-motion-control',
    provider: 'Kuaishou',
    family: 'Kling 3.0 Motion Control',
    models: [{ id: 'kling-3.0-motion-control', workflows: ['motion-control'] }],
    resolutions: ['720p', '1080p'],
    resolutionDefault: '720p',
    orientation: true,
    elements: true,
    limitations: ['A single facial element is allowed only with video orientation.']
  },
  {
    slug: 'kling-avatar-2-0',
    provider: 'Kuaishou',
    family: 'Kling Avatar 2.0',
    models: [
      { id: 'kling-avatar-2.0/standard', workflows: ['avatar-video'] },
      { id: 'kling-avatar-2.0/pro', workflows: ['avatar-video'] }
    ],
    limitations: ['Excluded from initial scope because it is an audio-driven avatar workflow.']
  },
  {
    slug: 'kling-o3',
    provider: 'Kuaishou',
    family: 'Kling O3',
    models: [
      { id: 'kling-o3/standard', workflows: klingRich },
      { id: 'kling-o3/pro', workflows: klingRich }
    ],
    durations: { min: 3, max: 15 },
    ratios: ratiosThree,
    sound: true,
    elements: true,
    limitations: [
      'Up to two image anchors and four references; multi-shot requires multi_prompt and sound=true.'
    ]
  },
  {
    slug: 'kling-o3-4k',
    provider: 'Kuaishou',
    family: 'Kling O3 4K',
    models: [{ id: 'kling-o3/4K', workflows: klingRich }],
    durations: { min: 3, max: 15 },
    ratios: ratiosThree,
    sound: true,
    elements: true,
    limitations: ['Native 4K O3 follows the same anchor/reference/multi-shot rules.']
  },
  {
    slug: 'omni-flash',
    provider: 'Poyo',
    family: 'Omni Flash',
    models: [
      {
        id: 'omni-flash',
        workflows: ['text-to-video', 'image-to-video', 'image-fusion-video', 'video-to-video']
      }
    ],
    durations: [4, 6, 8, 10],
    durationDefault: 6,
    ratios: ['16:9', '9:16'],
    ratioDefault: '16:9',
    resolutions: ['720p', '1080p', '4k'],
    resolutionDefault: '720p',
    limitations: [
      'Image count must be exactly one or three, never two; duration is omitted for video input.'
    ]
  },
  {
    slug: 'runway-gen-4-5',
    provider: 'Runway',
    family: 'Runway Gen-4.5',
    models: [{ id: 'runway-gen-4.5', workflows: textImage }],
    prompt: [1, 1800],
    durations: [5, 10],
    durationDefault: 5,
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    ratioDefault: '16:9',
    seed: true
  },
  {
    slug: 'seedance-1.0-pro',
    provider: 'ByteDance',
    family: 'Seedance 1.0 Pro',
    models: [{ id: 'seedance-1.0-pro', workflows: textImage }],
    prompt: [1, 10000],
    resolutions: ['720p', '1080p'],
    durations: [5, 10]
  },
  {
    slug: 'seedance-1-5-pro',
    provider: 'ByteDance',
    family: 'Seedance 1.5 Pro',
    models: [
      { id: 'seedance-1.5-pro', workflows: ['text-to-video', 'image-to-video', 'frame-to-video'] }
    ],
    ratios: ratiosSix,
    resolutions: ['480p', '720p', '1080p'],
    durations: [4, 8, 12],
    fixedLens: true,
    generateAudio: true
  },
  {
    slug: 'seedance-2',
    provider: 'ByteDance',
    family: 'Seedance 2',
    models: [
      { id: 'seedance-2', workflows: ['text-to-video', 'frame-to-video', 'reference-to-video'] },
      {
        id: 'seedance-2-fast',
        workflows: ['text-to-video', 'frame-to-video', 'reference-to-video']
      }
    ],
    prompt: [3, 20000],
    ratios: seedanceRatios,
    resolutions: ['480p', '720p', '1080p', '4k'],
    durations: { min: 4, max: 15 },
    generateAudio: true,
    limitations: [
      'Frame inputs conflict with all references; reference audio requires an image or video reference.'
    ]
  },
  {
    slug: 'seedance-2-mini',
    provider: 'ByteDance',
    family: 'Seedance 2 Mini',
    models: [
      {
        id: 'seedance-2-mini',
        workflows: ['text-to-video', 'frame-to-video', 'reference-to-video']
      }
    ],
    ratios: seedanceRatios,
    resolutions: ['480p', '720p'],
    resolutionDefault: '720p',
    durations: { min: 4, max: 15 },
    generateAudio: true,
    limitations: [
      'Frame inputs conflict with all references; reference audio requires an image or video reference.'
    ]
  },
  {
    slug: 'sora-2-official',
    provider: 'OpenAI',
    family: 'Sora 2 Official',
    models: [{ id: 'sora-2-official', workflows: textImage }],
    durations: [4, 8, 12, 16, 20],
    durationDefault: 4,
    ratios: ['16:9', '9:16'],
    ratioDefault: '16:9'
  },
  {
    slug: 'sora-2-pro-official',
    provider: 'OpenAI',
    family: 'Sora 2 Pro Official',
    models: [{ id: 'sora-2-pro-official', workflows: textImage }],
    durations: [4, 8, 12, 16, 20],
    durationDefault: 4,
    ratios: ['auto', '9:16', '16:9'],
    ratioDefault: '16:9',
    resolutions: ['720p', '1024p', '1080p'],
    resolutionDefault: '1024p',
    limitations: ['aspect_ratio=auto is valid only when an image is supplied.']
  },
  {
    slug: 'veo-3-1',
    provider: 'Google',
    family: 'VEO 3.1',
    models: [
      { id: 'veo3.1-lite', workflows: ['text-to-video'] },
      {
        id: 'veo3.1-fast',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video', 'reference-to-video']
      },
      {
        id: 'veo3.1-quality',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video']
      }
    ],
    durations: [4, 6, 8],
    ratios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    limitations: ['Lite forbids images/generation_type; Quality forbids reference generation.']
  },
  {
    slug: 'veo-3-1-official',
    provider: 'Google',
    family: 'VEO 3.1 Official',
    models: [
      {
        id: 'veo3.1-lite-official',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video']
      },
      {
        id: 'veo3.1-fast-official',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video', 'reference-to-video']
      },
      {
        id: 'veo3.1-quality-official',
        workflows: ['text-to-video', 'image-to-video', 'frame-to-video', 'reference-to-video']
      }
    ],
    durations: [4, 6, 8],
    ratios: ['auto', '16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    resolutionDefault: '720p',
    sound: true,
    limitations: [
      'Reference, selected multi-image combinations, and Lite 1080p require 8 seconds; Lite forbids 4k.'
    ]
  },
  {
    slug: 'wan-2-6',
    provider: 'Alibaba',
    family: 'Wan 2.6',
    models: [
      { id: 'wan2.6-text-to-video', workflows: ['text-to-video'] },
      { id: 'wan2.6-image-to-video', workflows: ['image-to-video'] },
      { id: 'wan2.6-video-to-video', workflows: ['video-to-video'] }
    ],
    prompt: [1, 5000],
    durations: [5, 10, 15],
    resolutions: ['720p', '1080p'],
    multiShots: true,
    limitations: ['Video-to-video accepts 1–3 videos and duration 5 or 10 only.']
  },
  {
    slug: 'wan-2-7-video',
    provider: 'Alibaba',
    family: 'Wan 2.7 Video',
    models: [
      { id: 'wan2.7-text-to-video', workflows: ['text-to-video'] },
      { id: 'wan2.7-image-to-video', workflows: ['frame-to-video'] },
      { id: 'wan2.7-reference-to-video', workflows: ['reference-to-video'] },
      { id: 'wan2.7-edit-video', workflows: ['video-edit'] }
    ],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    ratioDefault: '16:9',
    resolutions: ['720p', '1080p'],
    resolutionDefault: '720p',
    seed: true,
    safety: true,
    multiShots: true,
    audio: 'setting',
    limitations: [
      'Workflow-specific durations and source/reference roles are enforced; edit duration 0 probes the source.'
    ]
  },
  {
    slug: 'wan-animate',
    provider: 'Alibaba',
    family: 'Wan Animate',
    models: [
      { id: 'wan-animate-move', workflows: ['character-animation'] },
      { id: 'wan-animate-replace', workflows: ['character-replacement'] }
    ],
    resolutions: ['480p', '580p', '720p'],
    resolutionDefault: '480p'
  },
  {
    slug: 'wan2.2-image-to-video-fast',
    provider: 'Alibaba',
    family: 'Wan 2.2 I2V Fast',
    models: [{ id: 'wan2.2-image-to-video-fast', workflows: ['frame-to-video'] }],
    prompt: [1, 800],
    resolutions: ['480p', '720p'],
    resolutionDefault: '480p',
    seed: true
  },
  {
    slug: 'wan2.2-text-to-video-fast',
    provider: 'Alibaba',
    family: 'Wan 2.2 T2V Fast',
    models: [{ id: 'wan2.2-text-to-video-fast', workflows: ['text-to-video'] }],
    prompt: [1, 800],
    ratios: ['16:9', '9:16'],
    ratioDefault: '16:9',
    resolutions: ['480p', '720p'],
    resolutionDefault: '720p',
    seed: true
  },
  {
    slug: 'wan2.5-image-to-video',
    provider: 'Alibaba',
    family: 'Wan 2.5 I2V',
    models: [{ id: 'wan2.5-image-to-video', workflows: ['image-to-video'] }],
    prompt: [1, 1500],
    resolutions: ['480p', '720p', '1080p'],
    resolutionDefault: '720p',
    durations: [5, 10],
    durationDefault: 5,
    negativePrompt: true,
    seed: true,
    audio: 'string'
  },
  {
    slug: 'wan2.5-text-to-video',
    provider: 'Alibaba',
    family: 'Wan 2.5 T2V',
    models: [{ id: 'wan2.5-text-to-video', workflows: ['text-to-video'] }],
    prompt: [1, 1500],
    ratios: ['832*480', '480*832', '1280*720', '720*1280', '1920*1080', '1080*1920'],
    durations: [5, 10],
    durationDefault: 5,
    negativePrompt: true,
    seed: true,
    audio: 'string',
    limitations: ['audio is an optional string; boolean values are invalid.']
  }
];

function mediaRole(
  role: InputRole['role'],
  requestKey: keyof GuidedVideoRequest,
  apiKey: string,
  mediaKind: InputRole['mediaKind'],
  required: boolean,
  min: number,
  max: number | null
): InputRole {
  return {
    role,
    requestKey,
    apiKey,
    mediaKind,
    required,
    min,
    max,
    formats:
      mediaKind === 'image' ? imageFormats : mediaKind === 'video' ? videoFormats : audioFormats
  };
}

function rolesFor(page: Page, modelId: string, workflow: VideoWorkflow): InputRole[] {
  if (workflow === 'text-to-video' && page.family === 'Wan 2.7 Video')
    return [mediaRole('audio', 'audioUrl', 'audio_url', 'audio', false, 0, 1)];
  if (workflow === 'image-to-video') {
    if (['Hailuo 2.3', 'Kling 2.1', 'Kling 2.5 Turbo Pro'].includes(page.family))
      return [mediaRole('start-frame', 'startImageUrl', 'start_image_url', 'image', true, 1, 1)];
    return [mediaRole('image', 'imageUrls', 'image_urls', 'image', true, 1, 1)];
  }
  if (workflow === 'frame-to-video') {
    if (page.family === 'Wan 2.7 Video')
      return [
        mediaRole('start-frame', 'imageUrls', 'image_urls', 'image', true, 1, 2),
        mediaRole('source-video', 'videoUrl', 'video_url', 'video', false, 0, 1),
        mediaRole('audio', 'audioUrl', 'audio_url', 'audio', false, 0, 1)
      ];
    if (page.family === 'Hailuo 02')
      return [
        mediaRole('start-frame', 'imageUrls', 'image_urls', 'image', true, 1, 1),
        mediaRole('end-frame', 'endImageUrl', 'end_image_url', 'image', true, 1, 1)
      ];
    if (['Kling 1.6', 'Kling 2.1', 'Kling 2.5 Turbo Pro'].includes(page.family))
      return [
        mediaRole('start-frame', 'startImageUrl', 'start_image_url', 'image', true, 1, 1),
        mediaRole('end-frame', 'endImageUrl', 'end_image_url', 'image', true, 1, 1)
      ];
    if (page.family === 'Kling 2.6')
      return [
        mediaRole('start-frame', 'imageUrls', 'image_urls', 'image', true, 1, 1),
        mediaRole('end-frame', 'endImageUrl', 'end_image_url', 'image', true, 1, 1)
      ];
    if (page.family.includes('VEO'))
      return [mediaRole('start-frame', 'imageUrls', 'image_urls', 'image', true, 2, 2)];
    const max = 2;
    return [mediaRole('start-frame', 'imageUrls', 'image_urls', 'image', true, 1, max)];
  }
  if (workflow === 'reference-to-video') {
    if (page.family.includes('VEO 3.1'))
      return [mediaRole('reference-image', 'imageUrls', 'image_urls', 'image', true, 3, 3)];
    if (page.family.startsWith('Happy Horse'))
      return [
        mediaRole(
          'reference-image',
          'referenceImageUrls',
          'reference_image_urls',
          'image',
          true,
          1,
          page.family === 'Happy Horse 1.1' ? 9 : null
        )
      ];
    if (page.family.startsWith('Seedance 2'))
      return [
        mediaRole(
          'reference-image',
          'referenceImageUrls',
          'reference_image_urls',
          'image',
          false,
          0,
          9
        ),
        mediaRole(
          'reference-video',
          'referenceVideoUrls',
          'reference_video_urls',
          'video',
          false,
          0,
          3
        ),
        mediaRole(
          'reference-audio',
          'referenceAudioUrls',
          'reference_audio_urls',
          'audio',
          false,
          0,
          3
        )
      ];
    if (page.family.startsWith('Kling O3'))
      return [
        mediaRole('start-frame', 'imageUrls', 'image_urls', 'image', false, 0, 2),
        mediaRole(
          'reference-image',
          'referenceImageUrls',
          'reference_image_urls',
          'image',
          true,
          1,
          4
        )
      ];
    if (page.family === 'Kling 1.6')
      return [mediaRole('reference-image', 'imageUrls', 'image_urls', 'image', true, 1, 4)];
    if (page.family === 'Wan 2.7 Video')
      return [
        mediaRole(
          'reference-image',
          'referenceImageUrls',
          'reference_image_urls',
          'image',
          false,
          0,
          null
        ),
        mediaRole(
          'reference-video',
          'referenceVideoUrls',
          'reference_video_urls',
          'video',
          false,
          0,
          null
        )
      ];
    return [];
  }
  if (workflow === 'video-to-video') {
    return [
      mediaRole(
        'source-video',
        'videoUrls',
        'video_urls',
        'video',
        true,
        1,
        modelId === 'wan2.6-video-to-video' ? 3 : 1
      )
    ];
  }
  if (workflow === 'video-edit') {
    return [
      mediaRole('source-video', 'videoUrl', 'video_url', 'video', true, 1, 1),
      mediaRole(
        'reference-image',
        'referenceImageUrls',
        page.family === 'Wan 2.7 Video' ? 'reference_image_url' : 'reference_image_urls',
        'image',
        false,
        0,
        page.family === 'Happy Horse' ? 5 : 1
      )
    ];
  }
  if (workflow === 'motion-control')
    return [
      mediaRole('image', 'imageUrls', 'image_urls', 'image', true, 1, 1),
      mediaRole('reference-video', 'videoUrls', 'video_urls', 'video', true, 1, 1)
    ];
  if (workflow === 'character-animation' || workflow === 'character-replacement')
    return [
      mediaRole('source-video', 'videoUrl', 'video_url', 'video', true, 1, 1),
      mediaRole('image', 'imageUrls', 'image_urls', 'image', true, 1, 1)
    ];
  if (workflow === 'image-fusion-video')
    return [mediaRole('reference-image', 'imageUrls', 'image_urls', 'image', true, 3, 3)];
  return [];
}

function field(
  key: keyof GuidedVideoRequest,
  apiKey: string,
  kind: FieldDefinition['kind'],
  level: FieldDefinition['level'],
  options: Omit<FieldDefinition, 'key' | 'apiKey' | 'kind' | 'level'> = {}
): FieldDefinition {
  return { key, apiKey, kind, level, ...options };
}

function effectiveDurations(page: Page, modelId: string, workflow: VideoWorkflow) {
  if (page.family === 'Hailuo 02' && modelId.endsWith('-pro')) return [6] as const;
  if (page.family === 'Wan 2.7 Video') {
    if (workflow === 'text-to-video') return [5, 10, 15] as const;
    if (workflow === 'frame-to-video') return { min: 2, max: 15 } as const;
    if (workflow === 'reference-to-video') return { min: 2, max: 10 } as const;
    return { min: 0, max: 10 } as const;
  }
  if (modelId === 'wan2.6-video-to-video') return [5, 10] as const;
  return page.durations ?? null;
}

function effectiveResolutions(page: Page, modelId: string) {
  if (page.family === 'Hailuo 02' && modelId.endsWith('-pro')) return ['1080P'] as const;
  if (page.family === 'Seedance 2' && modelId === 'seedance-2-fast')
    return ['480p', '720p'] as const;
  if (page.family === 'VEO 3.1' && modelId === 'veo3.1-lite') return ['720p', '1080p'] as const;
  if (page.family === 'VEO 3.1 Official' && modelId.includes('lite'))
    return ['720p', '1080p'] as const;
  return page.resolutions ?? null;
}

function fieldsFor(page: Page, modelId: string, workflow: VideoWorkflow): FieldDefinition[] {
  const isMultiShot = workflow === 'multi-shot-video';
  const promptExcluded =
    workflow === 'motion-control' ||
    workflow.startsWith('character-') ||
    workflow === 'avatar-video';
  const promptOptional =
    (page.family.startsWith('Happy Horse') &&
      ['image-to-video', 'video-edit'].includes(workflow)) ||
    (page.family === 'Wan 2.7 Video' && workflow === 'frame-to-video');
  const durations = effectiveDurations(page, modelId, workflow);
  const resolutions = effectiveResolutions(page, modelId);
  const omitDuration =
    (page.family === 'Happy Horse' && workflow === 'video-edit') ||
    (page.family === 'Omni Flash' && workflow === 'video-to-video');
  const omitRatio =
    (page.family === 'Kling 1.6' &&
      modelId.endsWith('/standard') &&
      workflow !== 'text-to-video') ||
    (page.family.startsWith('Kling 3.0 Turbo') && workflow === 'image-to-video') ||
    (page.family.startsWith('Kling O3') && workflow === 'frame-to-video');
  const fields: FieldDefinition[] = [];
  if (isMultiShot)
    fields.push(
      field('multiPrompt', 'multi_prompt', 'object-list', 'essential', {
        required: true,
        min: 1,
        max: 6
      })
    );
  else if (!promptExcluded)
    fields.push(
      field('prompt', 'prompt', 'text', 'essential', {
        required: !promptOptional,
        min: page.prompt?.[0] ?? 1,
        max: page.prompt?.[1] ?? 5000
      })
    );
  if (!omitDuration && durations) {
    if (!('min' in durations))
      fields.push(
        field('duration', 'duration', 'enum', 'common', {
          required: true,
          default: page.durationDefault ?? durations[0],
          enum: durations.map(String)
        })
      );
    else
      fields.push(
        field('duration', 'duration', 'integer', 'common', {
          required: true,
          default: page.durationDefault ?? (workflow === 'video-edit' ? 0 : durations.min),
          min: durations.min,
          max: durations.max
        })
      );
  }
  if (!omitRatio && page.ratios)
    fields.push(
      field('aspectRatio', 'aspect_ratio', 'enum', 'common', {
        required: page.family === 'Kling 2.6' || page.family === 'Seedance 1.5 Pro',
        default: page.ratioDefault,
        enum: page.ratios
      })
    );
  if (resolutions)
    fields.push(
      field('resolution', 'resolution', 'enum', 'common', {
        required: page.family === 'Seedance 2' || page.family === 'Kling 2.6 Motion Control',
        default: page.resolutionDefault ?? resolutions[0],
        enum: resolutions
      })
    );
  if (page.negativePrompt)
    fields.push(field('negativePrompt', 'negative_prompt', 'text', 'advanced'));
  if (page.cfgScale && workflow !== 'reference-to-video')
    fields.push(field('cfgScale', 'cfg_scale', 'number', 'advanced', { min: 0, max: 1 }));
  if (page.promptOptimizer)
    fields.push(
      field('promptOptimizer', 'prompt_optimizer', 'boolean', 'advanced', { default: true })
    );
  if (page.mode) fields.push(field('mode', 'mode', 'enum', 'common', { enum: page.mode }));
  if (page.seed)
    fields.push(field('seed', 'seed', 'integer', 'advanced', { min: 0, max: 2147483647 }));
  if (page.safety)
    fields.push(
      field('enableSafetyChecker', 'enable_safety_checker', 'boolean', 'common', { default: false })
    );
  if (page.fixedLens)
    fields.push(field('fixedLens', 'fixed_lens', 'boolean', 'advanced', { default: false }));
  if (page.generateAudio)
    fields.push(field('generateAudio', 'generate_audio', 'boolean', 'common', { default: false }));
  if (page.sound) {
    const fixedFrameOff = page.family === 'Kling 2.6' && workflow === 'frame-to-video';
    if (!fixedFrameOff)
      fields.push(field('sound', 'sound', 'boolean', 'common', { required: true, default: true }));
  }
  if (page.audio === 'string') fields.push(field('audio', 'audio', 'text', 'advanced'));
  if (page.audio === 'setting' && workflow === 'video-edit')
    fields.push(
      field('audioSetting', 'audio_setting', 'enum', 'common', {
        default: 'auto',
        ...(page.family === 'Happy Horse' ? { enum: ['auto', 'origin'] } : {})
      })
    );
  if (page.multiShots && !isMultiShot)
    fields.push(field('multiShots', 'multi_shots', 'boolean', 'advanced', { default: false }));
  if (page.elements && workflow === 'reference-to-video')
    fields.push(
      field('elements', 'kling_elements', 'elements', 'advanced', {
        required: page.family.startsWith('Kling 3.0')
      })
    );
  if (page.elements && workflow === 'motion-control')
    fields.push(field('elements', 'kling_elements', 'elements', 'advanced'));
  if (page.orientation) {
    fields.push(
      field('characterOrientation', 'character_orientation', 'enum', 'essential', {
        required: true,
        default: 'image',
        enum: ['image', 'video']
      })
    );
    fields.push(
      field('referenceVideoDuration', '__local_reference_video_duration', 'integer', 'advanced', {
        min: 3,
        max: 30
      })
    );
  }
  if (
    workflow === 'video-edit' &&
    (page.family === 'Happy Horse' || page.family === 'Wan 2.7 Video')
  )
    fields.push(
      field('sourceVideoDuration', '__local_source_video_duration', 'number', 'advanced', {
        min: page.family === 'Happy Horse' ? 3 : 2,
        max: page.family === 'Happy Horse' ? 60 : 10
      })
    );
  return fields;
}

function provenance(page: Page): RegistryProvenance {
  const sources = officialModelSources('video', page.slug);
  return {
    pageSlug: page.slug,
    markdownUrl: sources.markdown.url,
    markdownSha256: sources.markdown.sha256,
    jsonUrl: sources.json.url,
    jsonStatus: sources.json.status,
    jsonSha256: sources.json.sha256,
    sourceManifestVersion: `${OFFICIAL_SOURCE_MANIFEST.version}:${OFFICIAL_SOURCE_MANIFEST.corpusSha256}`,
    verifiedAt: VIDEO_VERIFIED_AT
  };
}

function rulesFor(page: Page, modelId: string, workflow: VideoWorkflow): string[] {
  return [
    ...(page.family.startsWith('Happy Horse') ? ['happy-horse-input-modes-exclusive'] : []),
    ...(page.family === 'Kling 1.6' ? ['kling-1.6-frames-elements-cfg-conflicts'] : []),
    ...(page.family === 'Kling 2.6' ? ['end-frame-requires-sound-false'] : []),
    ...(page.family.startsWith('Kling 3.0') || page.family.startsWith('Kling O3')
      ? ['prompt-vs-multi-prompt-and-sound']
      : []),
    ...(workflow === 'motion-control' ? ['orientation-controls-reference-video-duration'] : []),
    ...(page.family.startsWith('Seedance 2') ? ['frames-vs-references-and-reference-counts'] : []),
    ...(page.family.includes('VEO 3.1') ? ['generation-type-model-duration-matrix'] : []),
    ...(page.family === 'Wan 2.7 Video' ? ['wan-id-specific-input-and-duration'] : []),
    ...(page.family === 'Omni Flash'
      ? ['omni-image-count-one-or-three-and-video-omits-duration']
      : []),
    ...(modelId === 'wan2.6-video-to-video' ? ['video-to-video-duration-max-ten'] : [])
  ];
}

function entry(page: Page, model: Model, workflow: VideoWorkflow): VideoRegistryEntry {
  const excluded = workflow === 'avatar-video';
  const durations = effectiveDurations(page, model.id, workflow);
  const resolutions = effectiveResolutions(page, model.id);
  const fields = fieldsFor(page, model.id, workflow);
  const fixedInput: Record<string, unknown> = {};
  if (workflow === 'multi-shot-video') fixedInput.multi_shots = true;
  else if (page.family.startsWith('Kling 3.0') || page.family.startsWith('Kling O3'))
    fixedInput.multi_shots = false;
  if (page.family === 'Kling 2.6' && workflow === 'frame-to-video') fixedInput.sound = false;
  if (page.family.includes('VEO 3.1') && workflow === 'frame-to-video')
    fixedInput.generation_type = 'frame';
  if (page.family.includes('VEO 3.1') && workflow === 'reference-to-video')
    fixedInput.generation_type = 'reference';
  return {
    key: `${model.id}:${workflow}`,
    provider: page.provider,
    family: page.family,
    displayName: `${page.family} · ${workflow.replaceAll('-', ' ')}`,
    publicModelId: model.id,
    workflow,
    status: excluded ? 'excluded-initial-scope' : 'current',
    inputRoles: rolesFor(page, model.id, workflow),
    output: {
      mediaKind: 'video',
      formats: videoFormats,
      durations,
      resolutions,
      aspectRatios: page.ratios ?? null,
      seed: Boolean(page.seed),
      safetyChecker: Boolean(page.safety),
      audio: page.sound
        ? 'boolean-sound'
        : page.generateAudio
          ? 'boolean-generate'
          : page.audio
            ? 'string-setting'
            : 'none'
    },
    fields,
    ui: { form: 'guided-video', fieldOrder: fields.map((item) => item.key) },
    validation: { conditionalRules: rulesFor(page, model.id, workflow) },
    payload: {
      adapter: 'video-input-v1',
      ...(Object.keys(fixedInput).length ? { fixedInput } : {})
    },
    response: { normalizer: 'poyo-task-video-v1', mediaKind: 'video' },
    limitations: page.limitations ?? [],
    provenance: provenance(page)
  };
}

export const VIDEO_REGISTRY_ENTRIES: readonly VideoRegistryEntry[] = pages.flatMap((page) =>
  page.models.flatMap((model) => model.workflows.map((workflow) => entry(page, model, workflow)))
);
export const VIDEO_CURRENT_ENTRIES = VIDEO_REGISTRY_ENTRIES.filter(
  (entry) => entry.status === 'current'
);
export const VIDEO_EXCLUDED_ENTRIES = VIDEO_REGISTRY_ENTRIES.filter(
  (entry) => entry.status === 'excluded-initial-scope'
);
export const VIDEO_PAGE_SLUGS = pages.map((page) => page.slug);
export const VIDEO_PUBLIC_IDS = [
  ...new Set(VIDEO_REGISTRY_ENTRIES.map((entry) => entry.publicModelId))
];

export const VIDEO_AUDIT_RECORDS: readonly RegistryAuditRecord[] = [
  {
    key: 'unindexed:sora-2-beta',
    publicModelIds: ['sora-2-beta'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/api-manual/video-series/sora-2-beta.json',
    reason: 'Indexed OpenAPI has no current Markdown catalogue page.'
  },
  {
    key: 'legacy:sora-2',
    publicModelIds: ['sora-2', 'sora-2-private'],
    status: 'legacy',
    sourceUrl: 'https://docs.poyo.ai/api-manual/video-series/sora-2.json',
    reason: 'Deprecated Sora specification is retained outside selectors.'
  },
  {
    key: 'legacy:sora-2-pro',
    publicModelIds: ['sora-2-pro', 'sora-2-pro-private'],
    status: 'legacy',
    sourceUrl: 'https://docs.poyo.ai/api-manual/video-series/sora-2-pro.json',
    reason: 'Deprecated Sora Pro specification is retained outside selectors.'
  },
  {
    key: 'unindexed:sora2',
    publicModelIds: ['sora-2', 'sora-2-private'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/api-manual/video-series/sora2.json',
    reason: 'Duplicate-path OpenAPI is not a current catalogue page.'
  },
  {
    key: 'unindexed:sora2-pro',
    publicModelIds: ['sora-2-pro', 'sora-2-pro-private'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/api-manual/video-series/sora2-pro.json',
    reason: 'Duplicate-path OpenAPI is not a current catalogue page.'
  },
  {
    key: 'unindexed:veo3',
    publicModelIds: ['veo3.1-fast'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/api-manual/video-series/veo3.json',
    reason: 'Legacy duplicate VEO OpenAPI is outside selectors.'
  },
  {
    key: 'unindexed:openapi-sora2',
    publicModelIds: ['sora-2-official'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/openapi-sora2.json',
    reason: 'Top-level duplicate OpenAPI is outside selectors.'
  },
  {
    key: 'unindexed:openapi-veo3',
    publicModelIds: ['veo3.1-fast'],
    status: 'unindexed',
    sourceUrl: 'https://docs.poyo.ai/openapi-veo3.json',
    reason: 'Top-level duplicate OpenAPI is outside selectors.'
  }
];

const manifestMaterial = JSON.stringify({
  entries: VIDEO_REGISTRY_ENTRIES,
  audit: VIDEO_AUDIT_RECORDS
});
export const VIDEO_REGISTRY: RegistryManifest<VideoRegistryEntry> = {
  version: VIDEO_REGISTRY_VERSION,
  verifiedAt: VIDEO_VERIFIED_AT,
  pageCount: VIDEO_PAGE_SLUGS.length,
  publicIdCount: VIDEO_PUBLIC_IDS.length,
  entries: VIDEO_REGISTRY_ENTRIES,
  sourceCorpusHash: OFFICIAL_SOURCE_MANIFEST.corpusSha256,
  manifestHash: new Bun.CryptoHasher('sha256').update(manifestMaterial).digest('hex')
};
