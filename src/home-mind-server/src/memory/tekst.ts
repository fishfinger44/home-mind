/**
 * Fold away Polish diacritics before matching.
 *
 * Speech-to-text drops them often enough that a word list spelled only with
 * them would miss half the real cases — and JavaScript's `\b` sits awkwardly
 * next to non-ASCII letters, so "lubię" would not match a trailing boundary.
 *
 * Shared by the extraction gate (which reads what the user said) and the
 * garbage filters (which read what the extractor wrote). Both now match Polish,
 * and a pattern list is only as good as the normalisation in front of it, so
 * there must be exactly one of those.
 */
export function uprosc(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}
