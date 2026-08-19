import type { CareCase } from '@/lib/careApi';
import type { Study } from '@/lib/api';

export type ReportTemplateKind = 'report' | 'soap';

export interface ReportTemplateSection {
  key: string;
  label: string;
  placeholder: string;
}

export interface ReportTemplateDefinition {
  kind: ReportTemplateKind;
  title: string;
  reportTitle: string;
  sections: ReportTemplateSection[];
}

export const REPORT_TEMPLATES: Record<ReportTemplateKind, ReportTemplateDefinition> = {
  report: {
    kind: 'report',
    title: 'Diagnostic Report Template',
    reportTitle: 'Radiology Report',
    sections: [
      { key: 'indication', label: 'Indication', placeholder: 'Reason for exam and relevant history...' },
      { key: 'technique', label: 'Technique', placeholder: 'Protocol, contrast, comparison, limitations...' },
      { key: 'findings', label: 'Findings', placeholder: 'Structured imaging findings...' },
      { key: 'impression', label: 'Impression', placeholder: 'Numbered diagnostic impression...' },
      { key: 'recommendations', label: 'Recommendations', placeholder: 'Follow-up or communication notes...' },
    ],
  },
  soap: {
    kind: 'soap',
    title: 'SOAP Note Template',
    reportTitle: 'SOAP Clinical Note',
    sections: [
      { key: 'subjective', label: 'Subjective', placeholder: 'Patient-reported symptoms and history...' },
      { key: 'objective', label: 'Objective', placeholder: 'Exam, imaging, labs, and measurable findings...' },
      { key: 'assessment', label: 'Assessment', placeholder: 'Clinical assessment and diagnostic reasoning...' },
      { key: 'plan', label: 'Plan', placeholder: 'Plan, follow-up, medication, referral, or next steps...' },
    ],
  },
};

function line(label: string, value?: string | number | null) {
  return `${label}: ${value || '-'}`;
}

export function buildReportMetadataLines(input: { study?: Study | null; careCase?: CareCase | null }) {
  const { study, careCase } = input;
  if (study) {
    return [
      line('Patient', study.patient_name),
      line('Patient ID', study.patient_id),
      line('DOB', study.patient_dob),
      line('Study Date', study.study_date),
      line('Modality', study.modality),
      line('Client', study.client_name),
      line('Primary MD', study.md_name),
      line('Study ID', study.id),
    ];
  }

  if (careCase) {
    const currentStudy = (careCase.studyStack || []).find((entry) => entry.relation === 'current');
    return [
      line('Patient', careCase.patientName),
      line('Case', careCase.title),
      line('Doctor', careCase.doctorName),
      line('Shared At', new Date(careCase.createdAt).toLocaleString()),
      line('Current Study ID', currentStudy?.studyId),
      line('Modality', currentStudy?.modality),
      line('Study Date', currentStudy?.studyDate),
    ];
  }

  return [];
}

export function makeDraftStorageKey(input: {
  kind: ReportTemplateKind;
  studyId?: string | number | null;
  caseId?: string | null;
}) {
  return `report-draft:${input.kind}:${input.studyId || input.caseId || 'standalone'}`;
}
