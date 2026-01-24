/**
 * Converts a glob pattern to a RegExp.
 * Supports `*` (any chars except separator), `**` (any chars including separator),
 * and `?` (single character).
 */
export function globToRegExp(pattern: string): RegExp {
  let regexStr = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        regexStr += '.*';
        i++;
      } else {
        regexStr += '[^/]*';
      }
    } else if (char === '?') {
      regexStr += '.';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      regexStr += '\\' + char;
    } else {
      regexStr += char;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}
