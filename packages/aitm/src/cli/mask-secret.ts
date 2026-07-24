// Display mask for a secret shown in CLI output (config list, profile list, `config list
// --effective`): keep a short head + tail for identification, hide the middle. This is a DISPLAY
// mask, not a security scrubber — the log/error scrubber lives in logger/. A value of 12 chars or
// fewer is fully hidden, since a 6+…+4 view of it would leak most of it.
export function maskSecret(value: string): string {
  return value.length <= 12 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
