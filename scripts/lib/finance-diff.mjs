// Comparing the accounts of one payee, character by character (docs/finance/FINANCE.md, "Comparing accounts"). A bank
// merger leaves a payee with an old and a new number, and a one-digit slip is easy to miss by eye, so the Parties page
// marks the characters that differ. Pure and I/O-free so it is tested directly (finance-diff.test.mjs).

// `values` are the strings to compare (account numbers, IFSC codes, the last four digits ...). Returns, for each value,
// its characters as { ch, differs }. They are lined up from the RIGHT, because numbers of different lengths end in the
// same place; a character differs when the values are not all the same at that position (a missing position counts as
// different). One value has nothing to compare against, so nothing is marked.
export function markDiff(values) {
  const strings = values.map((v) => String(v));
  return strings.map((value, which) =>
    [...value].map((ch, i) => {
      const fromRight = value.length - 1 - i;
      const differs = strings.length > 1 && strings.some((other, j) => j !== which && other[other.length - 1 - fromRight] !== ch);
      return { ch, differs };
    }),
  );
}

// "1607155000056580" -> ["1607", "1550", "0005", "6580"]: groups of four counted from the right, for reading a long number.
export function groupFromRight(value, size = 4) {
  const text = String(value);
  const groups = [];
  for (let end = text.length; end > 0; end -= size) groups.unshift(text.slice(Math.max(0, end - size), end));
  return groups;
}
