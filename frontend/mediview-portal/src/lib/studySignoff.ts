export function openStudySignoffPopup(studyId: string | number) {
  if (typeof window === 'undefined') return null;

  const width = window.screen?.availWidth || 1280;
  const height = window.screen?.availHeight || 800;
  const features = [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    'left=0',
    'top=0',
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'scrollbars=yes',
    'resizable=yes',
  ].join(',');
  const popup = window.open(`/studies/${encodeURIComponent(String(studyId))}/sign`, `study-signoff-${studyId}`, features);
  popup?.focus();
  try {
    popup?.moveTo(0, 0);
    popup?.resizeTo(width, height);
  } catch {
    // Browser popup policies may ignore window sizing.
  }
  return popup;
}
