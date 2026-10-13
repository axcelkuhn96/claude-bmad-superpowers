import net from 'node:net';

export function publicIpv4(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 4 ||
      address.split('.').some(part => String(Number(part)) !== part)) return false;
  const [a, b, c] = address.split('.').map(Number);
  // Exclude non-global, special-use, documentation, benchmark and multicast space.
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) ||
      (b === 31 && c === 196) || (b === 52 && c === 193) ||
      (b === 88 && c === 99) || (b === 175 && c === 48) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export function publicTlsName(url) {
  if (url.protocol !== 'https:' || net.isIP(url.hostname)) return false;
  const labels = url.hostname.split('.');
  return labels.length >= 2 && url.hostname.length <= 253 &&
    labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
    !['localhost', 'local'].includes(labels.at(-1));
}
