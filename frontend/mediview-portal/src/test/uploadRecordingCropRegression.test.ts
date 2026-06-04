import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('UploadStudy recording crop regression', () => {
  it('updates the upload ref to the processed crop blob', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(
      /const nextBlob = new Blob\(chunks, \{ type: 'video\/webm' \}\);\s*recordingBlobRef\.current = nextBlob;\s*setRecordingBlob\(nextBlob\);/
    );
  });

  it('seeds the canvas at the trim start before recording the processed blob', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(
      /await seekToStart\(\);\s*drawFrame\(\);\s*rec\.start\(100\);\s*for \(let seedFrame = 0; seedFrame < 12; seedFrame \+= 1\) \{\s*await waitForAnimationFrame\(\);\s*drawFrame\(\);\s*\}\s*await video\.play\(\);/
    );
  });

  it('flushes recorder data before stopping a screen recording', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(/recorder\.requestData\?\.\(\);\s*recorder\.stop\(\);/);
  });

  it('does not hang forever if recording metadata cannot load for editing', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(/Timed out loading recording metadata for editing/);
    expect(source).toMatch(/window\.setTimeout\(\(\) => \{\s*if \(settled\) return;\s*settled = true;\s*cleanup\(\);\s*reject/);
  });

  it('flushes the processed crop recorder before stopping it', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(/if \(rec\.state !== 'inactive'\) \{\s*rec\.requestData\?\.\(\);\s*rec\.stop\(\);\s*\}/);
  });

  it('does not shave a frame from the recording trim end', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).not.toContain('RECORDING_END_EPSILON_SEC');
    expect(source).toMatch(/const getMaxTrimEnd = \(\) => Math\.max\(0, recordingDuration\);/);
    expect(source).toMatch(/const stopCap = Math\.max\(0, videoDuration\);/);
  });

  it('draws the final crop frame before stopping the processed recorder', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(/if \(video\.currentTime >= stopAt \|\| video\.ended\) \{\s*drawFrame\(\);\s*if \(rec\.state !== 'inactive'\)/);
  });

  it('falls back when the preferred crop recorder mime is unsupported', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/UploadStudy.tsx'), 'utf8');

    expect(source).toMatch(/try \{\s*rec = new MediaRecorder\(stream, \{ mimeType \}\);\s*\} catch \{\s*rec = new MediaRecorder\(stream\);\s*\}/);
  });
});
