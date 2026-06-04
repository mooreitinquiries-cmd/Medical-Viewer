import { describe, expect, it, vi } from 'vitest';

describe('DICOM screenshot URL helpers', () => {
  it('prefers configured API and includes fallback candidates', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_API', 'http://192.168.4.249:3001/api');
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });

    const api = await import('@/lib/api');
    const urls = api.getDicomScreenshotUrls('instance-1');

    expect(urls).toEqual([
      'https://viewer.example.com/api/dicom-instances/instance-1/screenshot?frame=0',
      'http://192.168.4.249:3001/api/dicom-instances/instance-1/screenshot?frame=0',
      'https://viewer.example.com:3001/api/dicom-instances/instance-1/screenshot?frame=0',
      'http://viewer.example.com:3001/api/dicom-instances/instance-1/screenshot?frame=0',
    ]);

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('media URL helpers', () => {
  it('uses the current app origin for proxied media paths by default', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });

    const api = await import('@/lib/api');

    expect(api.getMediaBaseUrl()).toBe('https://viewer.example.com');

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('fetchStudies', () => {
  it('normalizes wrapped studies payloads into an array', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          studies: [{ id: 7, patient_name: 'Jane Doe', modality: 'MRI' }],
        }),
      })
    );

    const api = await import('@/lib/api');
    const studies = await api.fetchStudies();

    expect(studies).toEqual([{ id: 7, patient_name: 'Jane Doe', modality: 'MRI' }]);

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('passes study auth headers when provided', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        studies: [{ id: 7, patient_name: 'Jane Doe', modality: 'MRI' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    await api.fetchStudies({
      auth: { email: 'doctor@example.com', role: 'doctor', name: 'Dr User' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/studies',
      expect.objectContaining({
        headers: {
          'x-user-email': 'doctor@example.com',
          'x-user-role': 'doctor',
          'x-user-name': 'Dr User',
        },
      })
    );

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('falls back across API base candidates after a network failure', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            studies: [{ id: 9, patient_name: 'Fallback Case', modality: 'CT' }],
          }),
        })
    );

    const api = await import('@/lib/api');
    const studies = await api.fetchStudies();

    expect(studies).toEqual([{ id: 9, patient_name: 'Fallback Case', modality: 'CT' }]);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/studies', { credentials: 'include' });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://viewer.example.com/api/studies', { credentials: 'include' });

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('falls back when a proxy candidate returns a 404 before the real API host', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ error: 'Not found' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ error: 'Still not found' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            studies: [{ id: 11, patient_name: 'Recovered Case', modality: 'US' }],
          }),
        })
    );

    const api = await import('@/lib/api');
    const studies = await api.fetchStudies();

    expect(studies).toEqual([{ id: 11, patient_name: 'Recovered Case', modality: 'US' }]);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/studies', { credentials: 'include' });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://viewer.example.com/api/studies', { credentials: 'include' });
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://viewer.example.com:3001/api/studies', { credentials: 'include' });

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('falls back when a proxy candidate returns HTML instead of JSON', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          json: async () => {
            throw new Error('Unexpected token <');
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            studies: [{ id: 12, patient_name: 'HTML Fallback', modality: 'CT' }],
          }),
        })
    );

    const api = await import('@/lib/api');
    const studies = await api.fetchStudies();

    expect(studies).toEqual([{ id: 12, patient_name: 'HTML Fallback', modality: 'CT' }]);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/studies', { credentials: 'include' });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://viewer.example.com/api/studies', { credentials: 'include' });

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns a clearer error when every API candidate is unreachable', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    );

    const api = await import('@/lib/api');

    await expect(api.fetchStudies()).rejects.toThrow(
      'Unable to reach the study API. Checked /api, https://viewer.example.com, https://viewer.example.com:3001, http://viewer.example.com:3001, http://192.168.4.249:3001. Verify the backend is running or set VITE_API.'
    );

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('recording upload integrity', () => {
  it('sends byte length and SHA-256 with case recording uploads', async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true, recording: { id: 'rec-1' } }),
    });
    const digestBytes = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
    const digestMock = vi.fn().mockResolvedValue(digestBytes.buffer);

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } });

    const api = await import('@/lib/api');
    const recording = new Blob(['video-bytes'], { type: 'video/webm' });
    Object.defineProperty(recording, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    });

    await api.uploadCaseRecording({
      recordingFile: recording,
      studyId: 42,
      uploadedBy: 'doctor@example.com',
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('recording_size')).toBe(String(recording.size));
    expect(body.get('recording_sha256')).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(digestMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('case stream presentation API', () => {
  it('loads a normalized presentation manifest for a saved stream', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        ok: true,
        presentation: {
          stream_id: 'stream-1',
          job_id: 'job-1',
          name: 'Morning list',
          video_url: '/api/case-stream/jobs/job-1/download',
          fps: 24,
          case_count: 1,
          cases: [
            {
              index: 0,
              study_id: 11,
              label: 'Case 11',
              start_sec: 0,
              end_sec: 4,
              duration_sec: 4,
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const manifest = await api.getSavedCaseStreamPresentation('stream-1', {
      auth: { email: 'doctor@example.com', role: 'doctor', name: 'Doctor' },
    });

    expect(manifest.case_count).toBe(1);
    expect(manifest.cases[0].study_id).toBe(11);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/case-stream/library/stream-1/presentation',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-user-email': 'doctor@example.com',
          'x-user-role': 'doctor',
        }),
      })
    );

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('updateStudyTechNotes', () => {
  it('saves tech notes to the selected study with auth headers', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        ok: true,
        study: { id: 11, tech_notes: 'Probe changed\nGain adjusted' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const result = await api.updateStudyTechNotes(11, 'Probe changed\nGain adjusted', {
      auth: { email: 'tech@example.com', role: 'doctor', name: 'Tech' },
    });

    expect(result.study.tech_notes).toBe('Probe changed\nGain adjusted');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/studies/11/tech-notes',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-user-email': 'tech@example.com',
          'x-user-role': 'doctor',
        }),
        body: JSON.stringify({ tech_notes: 'Probe changed\nGain adjusted' }),
      })
    );

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('uploadStudy', () => {
  it('uploads study with MP4 only when no DICOM files are attached', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 321, patient_name: 'MP4 Only Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/upload-mp4/321') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const mp4File = new File(['mp4-content'], 'clip.mp4', { type: 'video/mp4' });
    const result = await api.uploadStudy(
      {
        patient_name: 'Case A',
        study_date: '2026-05-14',
        modality: 'CT',
        notes: 'no dicom attached',
      },
      [],
      mp4File,
      null
    );

    expect(result.study_id).toBe(321);
    expect(result.dicom_count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uploads DICOM first then MP4 when both are present', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 444, patient_name: 'Mixed Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/444/dicom') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, study_id: 444, dicom_count: 2 }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/upload-mp4/444') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const dicom = new File(['dicom'], 'slice1.dcm', { type: 'application/dicom' });
    const mp4 = new File(['video'], 'review.mp4', { type: 'video/mp4' });
    const result = await api.uploadStudy(
      {
        patient_name: 'Case B',
        study_date: '2026-05-14',
        modality: 'CT',
        notes: 'mixed media',
      },
      [dicom],
      mp4,
      null
    );

    expect(result.study_id).toBe(444);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/studies/444/dicom');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/upload-mp4/444');

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends study auth headers when creating a study and uploading DICOM files', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 445, patient_name: 'Authenticated Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/445/dicom') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, study_id: 445, dicom_count: 1 }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const dicom = new File(['dicom'], 'slice1.dcm', { type: 'application/dicom' });
    await api.uploadStudy(
      {
        patient_name: 'Case B2',
        study_date: '2026-05-14',
        modality: 'CT',
        notes: 'authenticated dicom',
      },
      [dicom],
      null,
      null,
      { auth: { email: 'doctor@example.com', role: 'doctor', name: 'Dr Example' } }
    );

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-user-email': 'doctor@example.com',
      'x-user-role': 'doctor',
      'x-user-name': 'Dr Example',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'x-user-email': 'doctor@example.com',
      'x-user-role': 'doctor',
      'x-user-name': 'Dr Example',
    });

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the largest supported DICOM batch by default to avoid slow multi-request uploads', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 777, patient_name: 'Large DICOM Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/777/dicom') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, study_id: 777, dicom_count: 1 }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const dicomFiles = Array.from(
      { length: 201 },
      (_, index) => new File(['dicom'], `slice-${index + 1}.dcm`, { type: 'application/dicom' })
    );

    await api.uploadStudy(
      {
        patient_name: 'Case E',
        study_date: '2026-05-26',
        modality: 'CT',
        notes: 'large upload',
      },
      dicomFiles,
      null,
      null
    );

    const dicomUploadCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/studies/777/dicom')
    );
    expect(dicomUploadCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('splits large DICOM uploads by payload size to avoid stalled multipart requests', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_DICOM_UPLOAD_BATCH_MAX_MB', '1');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 778, patient_name: 'Large Payload DICOM Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/778/dicom') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, study_id: 778, dicom_count: 1 }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const dicomFiles = Array.from(
      { length: 3 },
      (_, index) =>
        new File([new Uint8Array(700_000)], `large-slice-${index + 1}.dcm`, {
          type: 'application/dicom',
        })
    );

    await api.uploadStudy(
      {
        patient_name: 'Case F',
        study_date: '2026-05-26',
        modality: 'CT',
        notes: 'large payload upload',
      },
      dicomFiles,
      null,
      null
    );

    const dicomUploadCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/studies/778/dicom')
    );
    expect(dicomUploadCalls).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uploads a DICOM file larger than the configured batch target as its own batch', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_DICOM_UPLOAD_BATCH_MAX_MB', '1');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 779, patient_name: 'Oversized DICOM Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/779/dicom') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, study_id: 779, dicom_count: 1 }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const oversizedDicom = new File([new Uint8Array(1_500_000)], 'oversized.dcm', {
      type: 'application/dicom',
    });
    const smallDicom = new File([new Uint8Array(100_000)], 'small.dcm', {
      type: 'application/dicom',
    });

    await api.uploadStudy(
      {
        patient_name: 'Case G',
        study_date: '2026-06-04',
        modality: 'CT',
        notes: 'oversized single-file batch',
      },
      [oversizedDicom, smallDicom],
      null,
      null
    );

    const dicomUploadCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/studies/779/dicom')
    );
    expect(dicomUploadCalls).toHaveLength(2);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('isolates a large DICOM before it can hold up smaller files in the same batch', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_DICOM_UPLOAD_BATCH_MAX_MB', '1');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 780, patient_name: 'Isolated Large DICOM Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/780/dicom') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, study_id: 780, dicom_count: 1 }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const largeDicom = new File([new Uint8Array(600_000)], 'large.dcm', {
      type: 'application/dicom',
    });
    const smallDicoms = ['small-1.dcm', 'small-2.dcm'].map(
      (name) => new File([new Uint8Array(100_000)], name, { type: 'application/dicom' })
    );

    await api.uploadStudy(
      {
        patient_name: 'Case H',
        study_date: '2026-06-04',
        modality: 'CT',
        notes: 'isolate large file',
      },
      [largeDicom, ...smallDicoms],
      null,
      null
    );

    const dicomUploadCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/studies/780/dicom')
    );
    expect(dicomUploadCalls).toHaveLength(2);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reports the unreadable DICOM filename and reason returned by the API', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/studies') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 781, patient_name: 'Unreadable DICOM Study' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      if (url.endsWith('/studies/781/dicom') && init?.method === 'POST') {
        return {
          ok: false,
          status: 502,
          json: async () => ({
            error: {
              message: 'Failed to upload DICOM files to Orthanc.',
              details: {
                failed_files: [
                  {
                    name: 'unreadable-large-file.dcm',
                    reason: 'File does not appear to be a valid DICOM object.',
                  },
                ],
              },
            },
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const unreadableDicom = new File(['not-dicom'], 'unreadable-large-file.dcm', {
      type: 'application/dicom',
    });

    await expect(
      api.uploadStudy(
        {
          patient_name: 'Case I',
          study_date: '2026-06-04',
          modality: 'OT',
          notes: 'unreadable DICOM error',
        },
        [unreadableDicom],
        null,
        null
      )
    ).rejects.toThrow(
      'Failed to upload DICOM files to Orthanc. File: unreadable-large-file.dcm (File does not appear to be a valid DICOM object.)'
    );

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('falls back to next API candidate when creating study fails due to network error', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 555, patient_name: 'Fallback Create Study' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const mp4 = new File(['video'], 'fallback.mp4', { type: 'video/mp4' });
    await api.uploadStudy(
      {
        patient_name: 'Case C',
        study_date: '2026-05-14',
        modality: 'MR',
        notes: 'fallback create',
      },
      [],
      mp4,
      null
    );

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/studies', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://viewer.example.com/api/studies', expect.any(Object));

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('falls back to next API candidate when MP4 upload fails due to network error', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 666, patient_name: 'Fallback MP4' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('@/lib/api');
    const mp4 = new File(['video'], 'fallback-mp4.mp4', { type: 'video/mp4' });
    await api.uploadStudy(
      {
        patient_name: 'Case D',
        study_date: '2026-05-14',
        modality: 'US',
        notes: 'fallback mp4 upload',
      },
      [],
      mp4,
      null
    );

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/upload-mp4/666');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('https://viewer.example.com/api/upload-mp4/666');

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});
