// Helper function to compute the common prefix of two strings.
export function commonPrefix(s1: string, s2: string): string {
  let i = 0;
  while (i < s1.length && i < s2.length && s1[i] === s2[i]) {
    i++;
  }
  return s1.substring(0, i);
}
