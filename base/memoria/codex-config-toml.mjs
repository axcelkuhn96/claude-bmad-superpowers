const events = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PreToolUse']);

function hasExactly(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function codexTomlString(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('invalid_codex_hook');
  let encoded = '"';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) {
      throw new TypeError('invalid_codex_hook');
    }
    encoded += char === '\\' ? '\\\\' : char === '"' ? '\\"' : char;
  }
  return encoded + '"';
}

// Codex -c values are TOML. Only the exact CBS group shape verified by native.mjs
// is accepted here; these inline tables never come from caller CLI arguments.
export function codexHookOverride(event, groups) {
  const skill = event === 'PreToolUse';
  if (!events.has(event) || !Array.isArray(groups) || groups.length !== 1 ||
      !hasExactly(groups[0], skill ? ['matcher', 'hooks'] : ['hooks']) ||
      (skill && groups[0].matcher !== 'Bash') || !Array.isArray(groups[0].hooks) ||
      groups[0].hooks.length !== 1 ||
      !hasExactly(groups[0].hooks[0], ['type', 'command', 'timeout'])) {
    throw new TypeError('invalid_codex_hook');
  }
  const { type, command, timeout } = groups[0].hooks[0];
  if (type !== 'command' || timeout !== 10) throw new TypeError('invalid_codex_hook');
  const value = `hooks.${event}=[{${skill ? 'matcher="Bash",' : ''}hooks=[{type="command",command=${codexTomlString(command)},timeout=10}]}]`;
  if (value.length > 8192) throw new TypeError('invalid_codex_hook');
  return value;
}
