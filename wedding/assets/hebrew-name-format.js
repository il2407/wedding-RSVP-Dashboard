// Formats a list of names into a natural Hebrew string, joining the last two
// entries with the conjunction "ו" (e.g. ["גבי", "נדב"] -> "גבי ונדב",
// ["גבי", "נדב", "רון"] -> "גבי, נדב ורון") instead of plain concatenation.
function formatHebrewNameList(names) {
  const cleaned = (Array.isArray(names) ? names : [names])
    .map((name) => (name === null || name === undefined ? '' : String(name).trim()))
    .filter(Boolean);

  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} ו${cleaned[1]}`;

  const last = cleaned[cleaned.length - 1];
  const rest = cleaned.slice(0, -1);
  return `${rest.join(', ')} ו${last}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatHebrewNameList };
}
