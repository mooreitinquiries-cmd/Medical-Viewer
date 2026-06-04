export function formatVideoTime(seconds: number, precision = 0): string {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds - minutes * 60;

  if (minutes <= 0) {
    return `${remainingSeconds.toFixed(precision)}s`;
  }

  return `${minutes}m ${remainingSeconds.toFixed(precision)}s`;
}
