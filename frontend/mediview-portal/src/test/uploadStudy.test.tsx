import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import UploadStudy from '@/pages/UploadStudy';

const navigateMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

const uploadStudyMock = vi.fn();
const uploadCaseRecordingMock = vi.fn();

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

vi.mock('@/components/ui/select', () => {
  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) {
    const childrenArray = Array.isArray(children) ? children : [children];
    const trigger = childrenArray.find((child) => {
      return Boolean(child && typeof child === 'object' && 'props' in child && child.props?.id);
    }) as { props?: { id?: string } } | undefined;
    const ariaLabel = trigger?.props?.id === 'patient_sex' ? 'Sex *' : 'Modality *';
    return (
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="">Select modality</option>
        {children}
      </select>
    );
  }

  const SelectTrigger = () => null;
  const SelectValue = () => null;
  const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  );

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

vi.mock('@/components/ui/slider', () => ({
  Slider: () => <div data-testid="slider-mock" />,
}));

vi.mock('@/lib/api', () => ({
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

function fillRequiredDemographics() {
  fireEvent.change(screen.getByLabelText('Age *'), { target: { value: '45' } });
  fireEvent.change(screen.getByLabelText('Sex *'), { target: { value: 'Female' } });
  fireEvent.change(screen.getByLabelText('Zip Code *'), { target: { value: '90210' } });
}

describe('UploadStudy validations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBasicMediaRecorderMocks();
    uploadStudyMock.mockResolvedValue({ ok: true, study_id: 777, study: { id: 777 } });
    uploadCaseRecordingMock.mockResolvedValue({ ok: true, recording: { id: 'r1' } });
  });

  it('rejects submit when required metadata exists but no media is attached', async () => {
    render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title *'), { target: { value: 'No Media Case' } });
    fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality *'), { target: { value: 'CT' } });

    fireEvent.click(screen.getByRole('button', { name: 'Upload Study' }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Attach DICOM/JPEG2000 files or another media type (MP4 or screen recording).'
      );
    });
    expect(uploadStudyMock).not.toHaveBeenCalled();
  });

  it('submits successfully with screen recording only (no DICOM, no MP4)', async () => {
    render(
      <MemoryRouter>
        <UploadStudy />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Study Title *'), { target: { value: 'Recording Only Case' } });
    fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality *'), { target: { value: 'MR' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Recording' }));
    await screen.findByText(/Recording ready/);

    const uploadButton = screen.getByRole('button', { name: 'Upload Study' });
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

    fireEvent.change(screen.getByLabelText('Study Title *'), { target: { value: 'Fast DICOM Case' } });
    fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality *'), { target: { value: 'CT' } });

    const fileInputs = container.querySelectorAll('input[type="file"]');
    const dicomInput = fileInputs[0] as HTMLInputElement;
    const dicom = new File(['dicom-bytes'], 'slice-1.dcm', { type: 'application/dicom' });
    fireEvent.change(dicomInput, { target: { files: [dicom] } });

    fireEvent.click(screen.getByRole('button', { name: 'Upload Study' }));

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

    fireEvent.change(screen.getByLabelText('Study Title *'), { target: { value: 'JPEG2000 Case' } });
    fillRequiredDemographics();
    fireEvent.change(screen.getByLabelText('Modality *'), { target: { value: 'US' } });

    const fileInputs = container.querySelectorAll('input[type="file"]');
    const jpeg2000Input = fileInputs[1] as HTMLInputElement;
    const jpeg2000 = new File(['jpeg2000-bytes'], 'image.jp2', { type: 'image/jp2' });
    fireEvent.change(jpeg2000Input, { target: { files: [jpeg2000] } });

    fireEvent.click(screen.getByRole('button', { name: 'Upload Study' }));

    await waitFor(() => expect(uploadStudyMock).toHaveBeenCalledTimes(1));
    expect(uploadStudyMock.mock.calls[0][4]).toMatchObject({
      convertJpeg2000ToDcm: true,
      redactTextOnUpload: false,
    });
  });
});
