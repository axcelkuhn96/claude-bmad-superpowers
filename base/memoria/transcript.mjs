import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { readWindowsBinary } from './windows-security.mjs';

export const POLICY_VERSION = 'native-v2';
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function readCompleteJsonl(buffer, start = 0) {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(start) || start < 0) throw new Error('invalid_jsonl_slice');
  const records = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(10, cursor);
    if (newline < 0) break;
    const end = newline + 1;
    const line = buffer.subarray(cursor, buffer[newline - 1] === 13 ? newline - 1 : newline);
    if (line.length) {
      let value;
      try { value = JSON.parse(decoder.decode(line)); }
      catch (error) { throw new Error('invalid_complete_jsonl', { cause: error }); }
      if (!object(value)) throw new Error('invalid_complete_jsonl');
      records.push({ value, start: start + cursor, end: start + end });
    }
    cursor = end;
  }
  return { records, lastCompleteByte: start + cursor };
}

const textFrom = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => object(item) && typeof item.text === 'string').map(item => item.text).join('\n') : '';

function claudeMessage(row) {
  if (!['user', 'assistant'].includes(row.type) || !object(row.message) ||
      row.message.role !== row.type) return null;
  const blocks = Array.isArray(row.message.content) ? row.message.content : [];
  const result = blocks.find(item => item?.type === 'tool_result');
  const call = blocks.find(item => item?.type === 'tool_use');
  const origin = result || call ? 'tool' : row.type === 'assistant' ? 'assistant' :
    row.isSidechain === true || row.agentId ? 'agent' :
      row.isSidechain === false && row.userType === 'external' && !row.sourceToolAssistantUUID &&
        row.isMeta !== true && row.isCompactSummary !== true &&
        row.isVisibleInTranscriptOnly !== true
        ? 'human' : 'unknown';
  const actor = result ? `tool:${result.tool_use_id ?? 'unknown'}` : call
    ? `tool:${call.name ?? 'unknown'}` : row.type;
  const text = result ? textFrom(result.content) : call ? JSON.stringify(call.input ?? {}) : textFrom(row.message.content);
  const finalVisible = row.type === 'assistant' && !result && !call &&
    row.isSidechain === false && !row.agentId && row.isMeta !== true &&
    row.isCompactSummary !== true && row.isVisibleInTranscriptOnly !== true &&
    row.message.stop_reason === 'end_turn' && blocks.some(item =>
      item?.type === 'text' && typeof item.text === 'string' && item.text.trim());
  return { origin, actor, speakerRole: row.type, text, messageId: row.uuid,
    timestamp: row.timestamp, nativeSessionId: row.sessionId ?? null, finalVisible };
}

function codexTuiSource(meta, sessionId) {
  return meta?.source === 'cli' && meta?.originator === 'codex-tui' &&
    meta?.thread_source === 'user' && meta?.session_id === sessionId && meta?.id === sessionId;
}

function codexDirectUserText(payload) {
  const content = payload.content;
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return Array.isArray(content) && content.length > 0 && Array.isArray(kinds) &&
    kinds.length === content.length && content.every((item, index) =>
      kinds[index] === 'user.text' && object(item) && item.type === 'input_text' &&
      typeof item.text === 'string' && item.text.length > 0);
}

function codexMessage(row, directUser, tuiUser, sessionId) {
  if (tuiUser && row.type === 'event_msg' && row.payload?.type === 'item_completed') {
    const { thread_id, turn_id, item } = row.payload;
    if (thread_id === sessionId && typeof turn_id === 'string' && turn_id &&
        item?.type === 'UserMessage' && typeof item.id === 'string' && item.id &&
        typeof item.client_id === 'string' && item.client_id &&
        Array.isArray(item.content) && item.content.length === 1 &&
        item.content[0]?.type === 'text' && typeof item.content[0].text === 'string' &&
        item.content[0].text && typeof row.timestamp === 'string' && row.timestamp) {
      return { origin: 'human', actor: 'user', speakerRole: 'user', text: item.content[0].text,
        messageId: item.id, timestamp: row.timestamp, nativeSessionId: thread_id };
    }
  }
  if (row.type !== 'response_item' || !object(row.payload)) return null;
  const payload = row.payload;
  if (['custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'].includes(payload.type)) {
    return { origin: 'tool', actor: `tool:${payload.name ?? payload.call_id ?? 'unknown'}`,
      speakerRole: payload.type, text: typeof payload.output === 'string' ? payload.output :
        typeof payload.input === 'string' ? payload.input : '',
      messageId: payload.id ?? payload.call_id, timestamp: row.timestamp, nativeSessionId: null };
  }
  if (payload.type !== 'message' || !['user', 'assistant'].includes(payload.role)) return null;
  const finalVisible = payload.role === 'assistant' && payload.phase === 'final_answer' &&
    Array.isArray(payload.content) && payload.content.length > 0 &&
    payload.content.every(item => item?.type === 'output_text' &&
      typeof item.text === 'string' && item.text.trim());
  return { origin: payload.role === 'user' ? directUser && codexDirectUserText(payload)
    ? 'human' : 'unknown' : 'assistant', actor: payload.role,
    speakerRole: payload.role, text: textFrom(payload.content), messageId: payload.id,
    timestamp: row.timestamp, nativeSessionId: null, finalVisible };
}

export async function parsePersistedSlice({ cli, transcriptPath, start = 0, end, sessionId, expectedFile }) {
  if (!['claude', 'codex'].includes(cli) || typeof transcriptPath !== 'string' ||
      !Number.isSafeInteger(start) || start < 0 || (end !== undefined &&
      (!Number.isSafeInteger(end) || end < start)) || typeof sessionId !== 'string' || !sessionId) {
    throw new Error('invalid_transcript_request');
  }
  if (process.platform === 'win32') {
    const maxWindow = 4 * 1024 * 1024;
    const requested = Math.min(maxWindow, end === undefined ? maxWindow : end - start);
    const observed = await readWindowsBinary(transcriptPath,
      { offset: start, length: requested, privateState: false });
    if (expectedFile?.fileId && expectedFile.fileId !== observed.fileId) {
      throw new Error('unsafe_transcript');
    }
    const bytes = observed.bytes;
    const parsed = readCompleteJsonl(bytes, start);
    if (parsed.lastCompleteByte === start && observed.size > start + maxWindow - 1) {
      throw new Error('oversized_transcript_record');
    }
    let directUser = false;
    let tuiUser = false;
    if (cli === 'codex') {
      let first = parsed.records[0]?.value;
      if (start > 0) {
        const header = await readWindowsBinary(transcriptPath,
          { offset: 0, length: 128 * 1024, privateState: false });
        if (header.fileId !== observed.fileId) throw new Error('unsafe_transcript');
        const newline = header.bytes.indexOf(10);
        if (newline >= 0) {
          try { first = JSON.parse(decoder.decode(header.bytes.subarray(0, newline))); }
          catch { first = null; }
        }
      }
      const meta = first?.type === 'session_meta' ? first.payload : null;
      if (meta && ((meta.session_id && meta.session_id !== sessionId) ||
          (meta.id && meta.id !== sessionId))) throw new Error('transcript_session_mismatch');
      directUser = ['exec', 'vscode'].includes(meta?.source) && meta?.thread_source === 'user' &&
        meta?.session_id === sessionId && meta?.id === sessionId;
      tuiUser = codexTuiSource(meta, sessionId);
    }
    const messages = [];
    for (const record of parsed.records) {
      const mapped = cli === 'claude' ? claudeMessage(record.value) :
        codexMessage(record.value, directUser, tuiUser, sessionId);
      if (!mapped) continue;
      if (!mapped.messageId || !mapped.timestamp ||
          (mapped.nativeSessionId && mapped.nativeSessionId !== sessionId)) throw new Error('invalid_native_message');
      messages.push({ ...mapped, cli, sessionId, start: record.start, end: record.end,
        policyVersion: POLICY_VERSION });
    }
    const after = await readWindowsBinary(transcriptPath,
      { offset: start, length: bytes.length, privateState: false });
    if (after.fileId !== observed.fileId || !after.bytes.equals(bytes)) throw new Error('unsafe_transcript');
    return { messages, lastCompleteByte: parsed.lastCompleteByte,
      completeBytes: bytes.subarray(0, parsed.lastCompleteByte - start), fileId: observed.fileId,
      size: observed.size };
  }
  const before = await fs.lstat(transcriptPath);
  if (!before.isFile() || (process.getuid && before.uid !== process.getuid()) ||
      (expectedFile && (before.dev !== expectedFile.dev || before.ino !== expectedFile.ino))) {
    throw new Error('unsafe_transcript');
  }
  const handle = await fs.open(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) ||
        stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('unsafe_transcript');
    const maxWindow = 4 * 1024 * 1024;
    const limit = Math.min(end ?? stat.size, stat.size, start + maxWindow);
    const bytes = Buffer.alloc(Math.max(0, limit - start));
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, start + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const parsed = readCompleteJsonl(bytes.subarray(0, read), start);
    if (parsed.lastCompleteByte === start && stat.size > start + maxWindow - 1) {
      throw new Error('oversized_transcript_record');
    }
    let directUser = false;
    let tuiUser = false;
    if (cli === 'codex') {
      let first = parsed.records[0]?.value;
      if (start > 0) {
        const header = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const newline = header.subarray(0, bytesRead).indexOf(10);
        if (newline >= 0) {
          try { first = JSON.parse(decoder.decode(header.subarray(0, newline))); }
          catch { first = null; }
        }
      }
      const meta = first?.type === 'session_meta' ? first.payload : null;
      if (meta && ((meta.session_id && meta.session_id !== sessionId) ||
          (meta.id && meta.id !== sessionId))) throw new Error('transcript_session_mismatch');
      directUser = ['exec', 'vscode'].includes(meta?.source) && meta?.thread_source === 'user' &&
        meta?.session_id === sessionId && meta?.id === sessionId;
      tuiUser = codexTuiSource(meta, sessionId);
    }
    const messages = [];
    for (const record of parsed.records) {
      const mapped = cli === 'claude' ? claudeMessage(record.value) :
        codexMessage(record.value, directUser, tuiUser, sessionId);
      if (!mapped) continue;
      if (!mapped.messageId || !mapped.timestamp ||
          (mapped.nativeSessionId && mapped.nativeSessionId !== sessionId)) throw new Error('invalid_native_message');
      messages.push({ ...mapped, cli, sessionId, start: record.start, end: record.end,
        policyVersion: POLICY_VERSION });
    }
    const after = await fs.lstat(transcriptPath);
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error('unsafe_transcript');
    return { messages, lastCompleteByte: parsed.lastCompleteByte,
      completeBytes: bytes.subarray(0, parsed.lastCompleteByte - start) };
  } finally { await handle.close(); }
}
