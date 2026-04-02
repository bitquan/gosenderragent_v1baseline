export type ChatMarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] };

export type ChatInlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string };

function pushParagraph(blocks: ChatMarkdownBlock[], lines: string[]) {
  if (lines.length > 0) {
    blocks.push({ kind: 'paragraph', text: lines.join('\n') });
    lines.length = 0;
  }
}

function pushList(
  blocks: ChatMarkdownBlock[],
  listState: { kind: 'unordered-list' | 'ordered-list'; items: string[] } | null,
) {
  if (!listState || listState.items.length === 0) {
    return null;
  }
  blocks.push({ kind: listState.kind, items: listState.items.slice() });
  return null;
}

export function parseChatMarkdownBlocks(input: string): ChatMarkdownBlock[] {
  const text = String(input || '').replace(/\r/g, '');
  if (!text.trim()) {
    return [];
  }

  const blocks: ChatMarkdownBlock[] = [];
  const paragraphLines: string[] = [];
  let listState: { kind: 'unordered-list' | 'ordered-list'; items: string[] } | null = null;

  let inFence = false;
  let fenceLanguage = '';
  const fenceLines: string[] = [];

  for (const line of text.split('\n')) {
    if (inFence) {
      if (/^```/.test(line)) {
        blocks.push({ kind: 'code', language: fenceLanguage, code: fenceLines.join('\n') });
        inFence = false;
        fenceLanguage = '';
        fenceLines.length = 0;
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    const fenceStart = line.match(/^```(.*)$/);
    if (fenceStart) {
      pushParagraph(blocks, paragraphLines);
      listState = pushList(blocks, listState);
      inFence = true;
      fenceLanguage = String(fenceStart[1] || '').trim();
      fenceLines.length = 0;
      continue;
    }

    if (!line.trim()) {
      pushParagraph(blocks, paragraphLines);
      listState = pushList(blocks, listState);
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      pushParagraph(blocks, paragraphLines);
      listState = pushList(blocks, listState);
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.+)$/);
    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      const kind = unorderedMatch ? 'unordered-list' : 'ordered-list';
      const itemText = String((unorderedMatch || orderedMatch)?.[1] || '').trim();
      if (listState && listState.kind === kind) {
        listState.items.push(itemText);
      } else {
        pushParagraph(blocks, paragraphLines);
        listState = pushList(blocks, listState);
        listState = { kind, items: [itemText] };
      }
      continue;
    }

    listState = pushList(blocks, listState);
    paragraphLines.push(line);
  }

  if (inFence) {
    const fenceOpen = `\`\`\`${fenceLanguage}`.trimEnd();
    blocks.push({
      kind: 'paragraph',
      text: [fenceOpen, ...fenceLines].join('\n'),
    });
  }

  pushParagraph(blocks, paragraphLines);
  listState = pushList(blocks, listState);
  return blocks;
}

export function tokenizeChatInlineText(value: string): ChatInlineToken[] {
  const text = String(value || '');
  if (!text) {
    return [];
  }

  const tokens: ChatInlineToken[] = [];
  const inlinePattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    const matched = match[0];
    if (matched.startsWith('`')) {
      tokens.push({ kind: 'code', value: matched.slice(1, -1) });
    } else {
      tokens.push({ kind: 'bold', value: matched.slice(2, -2) });
    }
    lastIndex = match.index + matched.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return tokens;
}
