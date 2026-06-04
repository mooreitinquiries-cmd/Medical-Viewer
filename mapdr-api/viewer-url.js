'use strict';

function sanitizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeBaseUrl(value) {
  const clean = sanitizeText(value);
  if (!clean) return '';
  return clean.replace(/\/+$/, '');
}

function parseAbsoluteHttpUrl(value, label) {
  const clean = normalizeBaseUrl(value);
  if (!clean) {
    throw new Error(`${label} is required`);
  }

  let url;
  try {
    url = new URL(clean);
  } catch (_) {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }

  return url;
}

function buildOhifStudyViewerUrl(baseUrl, studyInstanceUid) {
  const uid = sanitizeText(studyInstanceUid);
  if (!uid) {
    throw new Error('StudyInstanceUID is required');
  }

  const url = parseAbsoluteHttpUrl(baseUrl, 'OHIF viewer base URL');
  let basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.toLowerCase().endsWith('/viewer')) {
    basePath = basePath.slice(0, -'/viewer'.length);
  }

  url.pathname = `${basePath}/viewer/${encodeURIComponent(uid)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function buildExternalPacsViewerUrl(viewerBase, routePath, queryParams) {
  const base = normalizeBaseUrl(viewerBase);
  const pathPart = sanitizeText(routePath).replace(/^\/+/, '');
  const target = pathPart ? `${base}/${pathPart}` : base;
  const url = parseAbsoluteHttpUrl(target, 'External PACS viewer URL');

  Object.entries(queryParams || {}).forEach(function ([key, value]) {
    const cleanKey = sanitizeText(key);
    const cleanValue = sanitizeText(value);
    if (!cleanKey || !cleanValue) return;
    url.searchParams.set(cleanKey, cleanValue);
  });

  return url.toString();
}

module.exports = {
  buildExternalPacsViewerUrl,
  buildOhifStudyViewerUrl,
  normalizeBaseUrl,
};
