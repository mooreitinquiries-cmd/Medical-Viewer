import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import UploadStudy from '@/pages/UploadStudy';

const navigateMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

const uploadStudyMock = vi.fn();
const uploadCaseRecordingMock = vi.fn();
const addStudyReportMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'doctor@example.com', role: 'doctor', name: 'Dr Test' },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/components/ui/slider', () => ({
  Slider: () => <div data-testid="slider-mock" />,
}));

vi.mock('@/lib/api', () => ({
  addStudyReport: (...args: unknown[]) => addStudyReportMock(...args),
  uploadStudy: (...args: unknown[]) => uploadStudyMock(...args),
  uploadCaseRecording: (...args: unknown[]) => uploadCaseRecordingMock(...args),
  heartbeatLiveCase: vi.fn(),
  getLiveFinalizeJob: vi.fn(),
  listActiveLiveCases: vi.fn().mockResolvedValue([]),
  preconvertDicomFiles: vi.fn(),
  startLiveCase: vi.fn(),
  stopLiveCase: vi.fn(),
  uploadLiveCaseRecording: vi.fn(),
}));

vi.mock('@/lib/careApi', () => ({
  listCareClients: vi.fn().mockResolvedValue({
    clients: [
      {
        username: 'client.one',
        email: 'client@example.com',
        name: 'Client One',
        role: 'clinic',
        status: 'active',
        twoFactorEnabled: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: null,
      },
    ],
  }),
}));

function setupBasicMediaRecorderMocks() {
  const fakeStream = {
    getVideoTracks: () => [{ onended: null as unknown, stop: vi.fn() }],
    getTracks: () => [{ stop: vi.fn() }],
  };

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream),
    },
  });

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((event: { data?: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_stream: MediaStream, _opts?: { mimeType?: string }) {}
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['recording-bytes'], { type: 'video/webm' }) });
      this.onstop?.();
    }
  }

  // @ts-expect-error test shim
  globalThis.MediaRecorder = FakeMediaRecorder;
  // @ts-expect-error test shim
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:test-recording');
  // @ts-expect-error test shim
  globalThis.URL.revokeObjectURL = vi.fn();
}

async function fillRequiredDemographics() {
  await screen.findByDisplayValue('Sarai');
  fireEvent.change(screen.getByLabelText('DOB'), { target: { value: '1980-01-01' } });
  fireEvent.change(screen.getByLabelText('Study Date'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('Sex'), { target: { value: 'Female' } });
  fireEvent.change(screen.getByLabelText('Zip Code'), { target: { value: '90210' } });
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'Client One' } });
}

function getFileInputByAccept(container: HTMLElement, acceptPart: string) {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const input = inputs.find((candidate) => candidate.accept.includes(acceptPart));
  if (!input) throw new Error(`Could not find file input accepting ${acceptPart}`);
  return input;
}

describe('UploadStudy validations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBasicMediaRecorderMocks();
    uploadStudyMock.mockResolvedValue({ ok: true, study_id: 777, study: { id: 777 } });
    uploadCaseRecordingMock.mockResolvedValue({ ok: true, recording: { id: 'r1' } });
  });

  it('creates a case when metadata exists but no media is attached', async () => {
    render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title'), { target: { value: 'No Media Case' } });
    await fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality'), { target: { value: 'CT' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Case' }));

    await waitFor(() => expect(uploadStudyMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/studies');
  });

  it('creates a case with blank age when DOB and study date are omitted', async () => {
    render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title'), { target: { value: 'No Age Case' } });
    await screen.findByDisplayValue('Sarai');
    fireEvent.change(screen.getByLabelText('Sex'), { target: { value: 'Female' } });
    fireEvent.change(screen.getByLabelText('Zip Code'), { target: { value: '90210' } });
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'Client One' } });
    fireEvent.change(screen.getByLabelText('Modality'), { target: { value: 'CT' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Case' }));

    await waitFor(() => expect(uploadStudyMock).toHaveBeenCalledTimes(1));
    expect(uploadStudyMock.mock.calls[0][0]).toMatchObject({
      patient_dob: '',
      patient_age: '',
      study_date: '',
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('submits successfully with screen recording only (no DICOM, no MP4)', async () => {
    render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title'), { target: { value: 'Recording Only Case' } });
    await fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality'), { target: { value: 'MR' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Recording' }));
    await screen.findByText(/Recording ready/);

    const uploadButton = screen.getByRole('button', { name: 'Create Case' });
    fireEvent.submit(uploadButton.closest('form') as HTMLFormElement);

    await waitFor(() => expect(uploadStudyMock).toHaveBeenCalledTimes(1));
    expect(uploadStudyMock.mock.calls[0][1]).toEqual([]);
    expect(uploadStudyMock.mock.calls[0][2]).toBeNull();
    await waitFor(() => expect(uploadCaseRecordingMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).toHaveBeenCalledWith('/studies');
  });

  it('keeps JPEG2000 conversion off for normal DICOM uploads by default', async () => {
    const { container } = render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title'), { target: { value: 'Fast DICOM Case' } });
    await fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality'), { target: { value: 'CT' } });

    const dicomInput = getFileInputByAccept(container, 'application/dicom');
    const dicom = new File(['dicom-bytes'], 'slice-1.dcm', { type: 'application/dicom' });
    fireEvent.change(dicomInput, { target: { files: [dicom] } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Case' }));

    await waitFor(() => expect(uploadStudyMock).toHaveBeenCalledTimes(1));
    expect(uploadStudyMock.mock.calls[0][4]).toMatchObject({
      convertJpeg2000ToDcm: false,
      redactTextOnUpload: false,
    });
  });

  it('enables JPEG2000 conversion when JPEG2000 files are explicitly selected', async () => {
    const { container } = render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title'), { target: { value: 'JPEG2000 Case' } });
    await fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality'), { target: { value: 'US' } });

    const jpeg2000Input = getFileInputByAccept(container, '.j2c');
    const jpeg2000 = new File(['jpeg2000-bytes'], 'image.jp2', { type: 'image/jp2' });
    fireEvent.change(jpeg2000Input, { target: { files: [jpeg2000] } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Case' }));

    await waitFor(() => expect(uploadStudyMock).toHaveBeenCalledTimes(1));
    expect(uploadStudyMock.mock.calls[0][4]).toMatchObject({
      convertJpeg2000ToDcm: true,
      redactTextOnUpload: false,
    });
  });
});
