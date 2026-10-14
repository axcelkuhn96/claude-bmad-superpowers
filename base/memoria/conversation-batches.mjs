// Count complete root conversation turns, not assistant messages or tool calls.
export function completedConversationPairs(messages) {
  const pairs = [];
  let human = null;
  for (const message of messages) {
    if (message.origin === 'human') human = message;
    else if (message.origin === 'assistant' && message.finalVisible === true && human) {
      pairs.push({ human, assistant: message });
      human = null;
    }
  }
  return pairs;
}

export function conversationCutoff(messages, count = 5, force = false) {
  const pairs = completedConversationPairs(messages);
  if (pairs.length < count && !force || !pairs.length) return null;
  const selected = pairs.slice(0, Math.min(count, pairs.length));
  return { end: selected.at(-1).assistant.end, pairs: selected.length };
}
