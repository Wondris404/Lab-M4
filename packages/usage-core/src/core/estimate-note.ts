/** Shown when a total must not be treated as an exact bill. */
export const GENERIC_ESTIMATE_NOTE =
  'Čiastočný sken môže záznamy podhodnotiť, zopakovať alebo započítať dvakrát. Neistý súčet je len orientačný odhad.';

/** Prefer a parser warning that already states the counting risk and the estimate. */
export function estimateNoteFor(
  partial: boolean | undefined,
  warningDetails: readonly string[] | undefined,
): string | null {
  const specific = (warningDetails ?? []).find((item) => item.includes('orientačný odhad'));
  if (specific) return specific;
  return partial ? GENERIC_ESTIMATE_NOTE : null;
}
