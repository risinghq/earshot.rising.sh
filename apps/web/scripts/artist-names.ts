// Letters and digits only, lowercased, accents dropped: how curation compares
// titles and names across Deezer, iTunes and kworb.
export function fold(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

// The folded lengths at which a word of the name ends.
function wordEnds(text: string) {
  const ends = new Set<number>();
  let length = 0;
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    length += fold(word).length;
    ends.add(length);
  }
  return ends;
}

// "BIGBANG" is "BIGBANG (빅뱅)" and "多田葵" is "多田 葵 & VISUAL ARTS / Key",
// but "Shine" is not "SHINee": one folded name may extend the other only
// where a word of the longer one ends. Stores space CJK names unevenly, so
// the shorter name's own words do not count.
export function sameArtist(a: string, b: string) {
  const [short, long] = [a, b].sort((x, y) => fold(x).length - fold(y).length);
  const head = fold(short);
  return (
    head.length > 0 &&
    fold(long).startsWith(head) &&
    wordEnds(long).has(head.length)
  );
}
