// Bluesky enforces a 300-grapheme post limit. For ASCII-only posts that maps
// to 300 chars; we leave headroom for safety.
const POST_MAX_CHARS = 300;

/**
 * Build a rollup post body that fits under Bluesky's limit. Lines are assumed
 * worst-first. If everything fits unadorned we emit the full rollup; otherwise
 * we keep the longest prefix that fits alongside a "…and N more routes" tail.
 * Returns `null` if even one line + a tail won't fit in `maxChars`.
 */
function buildRollupPost(header, lines, maxChars = POST_MAX_CHARS) {
  if (lines.length === 0) return null;
  const moreTail = (n) => `\n…and ${n} more route${n === 1 ? '' : 's'}`;

  const full = `${header}\n\n${lines.join('\n')}`;
  if (full.length <= maxChars) return full;

  for (let k = lines.length - 1; k >= 1; k--) {
    const dropped = lines.length - k;
    const text = `${header}\n\n${lines.slice(0, k).join('\n')}${moreTail(dropped)}`;
    if (text.length <= maxChars) return text;
  }
  return null;
}

module.exports = { buildRollupPost, POST_MAX_CHARS };
