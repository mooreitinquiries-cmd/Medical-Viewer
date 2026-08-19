import { useEffect, useRef } from 'react';
import { fetchAcronym, type AcronymEntry } from '@/lib/api';

type EditableTextElement = HTMLInputElement | HTMLTextAreaElement;

const REPORT_FIELD_HINTS = ['report', 'note', 'diagnosis', 'impression', 'finding', 'clinical'];
const TOKEN_PATTERN = /^[A-Za-z0-9]{3,}$/;
const cache = new Map<string, AcronymEntry | null>();

function isEditableTextElement(element: EventTarget | null): element is EditableTextElement {
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return false;
  if (element.readOnly || element.disabled) return false;
  if (element instanceof HTMLInputElement && !['text', 'search'].includes(element.type)) return false;
  return true;
}

function shouldWatchElement(element: EditableTextElement) {
  if (element.dataset.acronymExpand === 'false') return false;
  if (element.dataset.acronymExpand === 'true') return true;
  if (element instanceof HTMLTextAreaElement) return true;

  const haystack = [
    element.name,
    element.id,
    element.placeholder,
    element.getAttribute('aria-label'),
    element.closest('[data-acronym-context]')?.getAttribute('data-acronym-context'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return REPORT_FIELD_HINTS.some((hint) => haystack.includes(hint));
}

function getCompletedToken(value: string, cursor: number) {
  if (cursor < 2) return null;
  const completedChar = value[cursor - 1] || '';
  if (!/[\s.,;:)\]}]/.test(completedChar)) return null;

  const beforeCursor = value.slice(0, cursor - 1);
  const match = beforeCursor.match(/([A-Za-z0-9]+)$/);
  if (!match) return null;

  const token = match[1];
  if (!TOKEN_PATTERN.test(token)) return null;
  return {
    token,
    start: cursor - 1 - token.length,
    end: cursor - 1,
  };
}

async function lookupAcronym(token: string) {
  const code = token.toUpperCase();
  if (cache.has(code)) return cache.get(code) || null;

  try {
    const response = await fetchAcronym(code);
    cache.set(code, response.acronym);
    return response.acronym;
  } catch (_) {
    cache.set(code, null);
    return null;
  }
}

function replaceTextRange(element: EditableTextElement, start: number, end: number, replacement: string) {
  const value = element.value;
  const nextValue = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  element.value = nextValue;
  const nextCursor = start + replacement.length;
  element.setSelectionRange(nextCursor, nextCursor);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: replacement }));
}

export default function AcronymExpansionWatcher() {
  const expandingRef = useRef(false);

  useEffect(() => {
    const onInput = async (event: Event) => {
      if (expandingRef.current) return;
      if (!isEditableTextElement(event.target)) return;

      const element = event.target;
      if (!shouldWatchElement(element)) return;
      const cursor = element.selectionStart ?? element.value.length;
      const tokenInfo = getCompletedToken(element.value, cursor);
      if (!tokenInfo) return;

      const acronym = await lookupAcronym(tokenInfo.token);
      if (!acronym || !acronym.diagnosis || document.activeElement !== element) return;

      expandingRef.current = true;
      try {
        replaceTextRange(element, tokenInfo.start, tokenInfo.end, acronym.diagnosis);
      } finally {
        window.setTimeout(() => {
          expandingRef.current = false;
        }, 0);
      }
    };

    document.addEventListener('input', onInput, true);
    return () => document.removeEventListener('input', onInput, true);
  }, []);

  return null;
}
