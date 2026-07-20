import { probeMediaTools } from '../src/lib/server/media/media-sanitizer';

const testFile = 'tests/media-tools/media-sanitizer.host.test.ts';
const readiness = await probeMediaTools();

function toolSummary(names: Array<(typeof readiness.tools)[number]['name']>): string {
  return names
    .map((name) => {
      const tool = readiness.tools.find((candidate) => candidate.name === name);
      if (!tool) return name;
      if (tool.status === 'ready') return `${tool.label} ${tool.detectedVersion}`;
      return `${tool.label} ${tool.status} (${tool.minimumVersion}+ needed)`;
    })
    .join(', ');
}

function runKind(
  label: 'image' | 'video',
  ready: boolean,
  tools: Parameters<typeof toolSummary>[0]
) {
  if (!ready) {
    console.log(`SKIP ${label} media-tool integration: ${toolSummary(tools)}.`);
    return 0;
  }

  console.log(`RUN ${label} media-tool integration: ${toolSummary(tools)}.`);
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      'test',
      '--max-concurrency',
      '1',
      testFile,
      '-t',
      `${label} sanitization`
    ],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  return result.exitCode;
}

const imageExitCode = runKind('image', readiness.imageReady, ['exiftool', 'imagemagick']);
if (imageExitCode !== 0) process.exit(imageExitCode);

const videoExitCode = runKind('video', readiness.videoReady, ['exiftool', 'ffmpeg', 'ffprobe']);
if (videoExitCode !== 0) process.exit(videoExitCode);

if (!readiness.imageReady && !readiness.videoReady) {
  console.log(
    'No supported local media-tool capability is available; optional integration tests skipped.'
  );
}
