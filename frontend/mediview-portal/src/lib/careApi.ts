import { getAuthApiBaseCandidates } from '@/lib/sessionApi';

export interface CarePatient {
  email: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
  lastLoginAt: string | null;
  openCaseCount: number;
}

export interface CareCase {
  id: string;
  title: string;
  notes: string;
  status: 'new' | 'reviewed';
  createdAt: string;
  updatedAt: string;
  patientEmail: string;
  patientName: string;
  doctorEmail: string;
  doctorName: string;
  studyStack?: CareCaseStudyStackEntry[];
  priorReports?: CareCasePriorReport[];
}

export interface CareCaseStudyStackEntry {
  studyId: number;
  relation: 'prior' | 'current';
  order: number;
  patientName?: string;
  patientId?: string;
  studyDate?: string;
  modality?: string;
  dicomCount?: number;
}

export interface CareCasePriorReport {
  url: string;
  filename?: string;
  sourceStudyId?: number | null;
  createdAt?: string;
}

export interface CareMessage {
  id: string;
  senderEmail: string;
  senderName: string;
  recipientEmail: string;
  recipientName: string;
  body: string;
  createdAt: string;
}

export interface CareContact {
  email: string;
  name: string;
  role: 'admin' | 'doctor' | 'patient' | 'clinic';
  title: string;
  latestMessageAt: string | null;
  unreadCount: number;
}

export interface CareCall {
  id: string;
  roomLabel: string;
  status: 'scheduled' | 'completed';
  scheduledAt: string;
  createdAt: string;
  organizerEmail: string;
  organizerName: string;
  contactEmail: string;
  contactName: string;
}

async function handleResponse(res: Response) {
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Care request failed (${res.status})`);
  }

  return data;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: Error | null = null;

  for (const baseUrl of getAuthApiBaseCandidates()) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {}),
        },
        ...init,
      });

      return (await handleResponse(res)) as T;
    } catch (error) {
      if (error instanceof TypeError) {
        lastError = error;
        continue;
      }

      throw error instanceof Error ? error : new Error('Care request failed');
    }
  }

  throw lastError || new Error('Unable to reach care API');
}

export async function listCarePatients(): Promise<{ patients: CarePatient[] }> {
  return request('/care/patients');
}

export async function listCareCases(): Promise<{ cases: CareCase[] }> {
  return request('/care/cases');
}

export async function createCareCase(payload: {
  patientEmail: string;
  title: string;
  notes: string;
  studyStack?: CareCaseStudyStackEntry[];
  priorReports?: CareCasePriorReport[];
}): Promise<{ case: CareCase }> {
  return request('/care/cases', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateCareCaseStatus(
  caseId: string,
  status: 'new' | 'reviewed'
): Promise<{ case: CareCase }> {
  return request(`/care/cases/${encodeURIComponent(caseId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function listCareContacts(): Promise<{ contacts: CareContact[] }> {
  return request('/care/messages/contacts');
}

export async function listCareMessages(contactEmail: string): Promise<{ messages: CareMessage[] }> {
  return request(`/care/messages/${encodeURIComponent(contactEmail)}`);
}

export async function sendCareMessage(
  contactEmail: string,
  body: string
): Promise<{ message: CareMessage }> {
  return request(`/care/messages/${encodeURIComponent(contactEmail)}`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function listCareCalls(): Promise<{ calls: CareCall[] }> {
  return request('/care/video/calls');
}

export async function scheduleCareCall(payload: {
  contactEmail: string;
  scheduledAt: string;
}): Promise<{ call: CareCall }> {
  return request('/care/video/calls', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function completeCareCall(callId: string): Promise<{ call: CareCall }> {
  return request(`/care/video/calls/${encodeURIComponent(callId)}/complete`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
}
