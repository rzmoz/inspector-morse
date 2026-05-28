// Faithful port of Node `path.posix` normalize/join/dirname so TS import
// resolution behaves identically regardless of the host OS separator.
// Mirror of Core/PosixPath.cs.

const SLASH = '/'.charCodeAt(0);
const DOT = '.'.charCodeAt(0);

function normalizeString(path, allowAboveRoot) {
  let res = '';
  let lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === SLASH) break;
    else code = SLASH;

    if (code === SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // no-op: empty segment or '.'
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2
            || res.charCodeAt(res.length - 1) !== DOT
            || res.charCodeAt(res.length - 2) !== DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex === -1) { res = ''; lastSegmentLength = 0; }
            else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf('/'); }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) {
            res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..';
          lastSegmentLength = 2;
        }
      } else {
        const seg = path.substring(lastSlash + 1, i);
        res = res.length > 0 ? res + '/' + seg : seg;
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      dots++;
    } else {
      dots = -1;
    }
  }
  return res;
}

export function normalize(path) {
  if (path.length === 0) return '.';
  const isAbsolute = path.charCodeAt(0) === SLASH;
  const trailing = path.charCodeAt(path.length - 1) === SLASH;
  path = normalizeString(path, !isAbsolute);
  if (path.length === 0) {
    if (isAbsolute) return '/';
    return trailing ? './' : '.';
  }
  if (trailing) path += '/';
  return isAbsolute ? '/' + path : path;
}

export function join(...args) {
  if (args.length === 0) return '.';
  let joined = null;
  for (const arg of args) {
    if (arg.length > 0) joined = joined === null ? arg : joined + '/' + arg;
  }
  return joined === null ? '.' : normalize(joined);
}

export function dirname(path) {
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path.charCodeAt(i) === SLASH) { if (!matchedSlash) { end = i; break; } }
    else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}
