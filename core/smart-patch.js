'use strict';

const fs = require('fs');
const path = require('path');

const { ensureDirectory, isWithin } = require('./utils');

function stripCodeFences(text) {
  const payload = String(text || '').replace(/\r\n/g, '\n');
  const fenced = payload.match(/^```(?:diff|patch)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : payload;
}

function splitContentLines(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) {
    lines.pop();
  }
  return { lines, endsWithNewline };
}

function joinContentLines(lines, endsWithNewline = true) {
  const joined = Array.isArray(lines) ? lines.join('\n') : '';
  return endsWithNewline ? `${joined}\n` : joined;
}

function normalizePatchPath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) {
    return '';
  }
  if (value === '/dev/null') {
    return value;
  }
  return value.replace(/^a\//, '').replace(/^b\//, '');
}

function parseHunkHeader(line) {
  const match = String(line || '').match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) {
    return null;
  }
  return {
    oldStart: Number.parseInt(match[1], 10) || 1,
    oldCount: match[2] === undefined ? 1 : (Number.parseInt(match[2], 10) || 0),
    newStart: Number.parseInt(match[3], 10) || 1,
    newCount: match[4] === undefined ? 1 : (Number.parseInt(match[4], 10) || 0),
    section: String(match[5] || '').trim(),
  };
}

function createFilePatch() {
  return {
    oldPath: '',
    newPath: '',
    hunks: [],
    header: '',
  };
}

function clampNumber(value, min = 0, max = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.min(max, Math.max(min, numeric));
}

function roundNumber(value, precision = 3) {
  const factor = 10 ** precision;
  return Math.round(clampNumber(value) * factor) / factor;
}

function confidenceLabel(normalized) {
  const score = clampNumber(normalized);
  if (score >= 0.92) {
    return 'high';
  }
  if (score >= 0.75) {
    return 'medium';
  }
  if (score >= 0.45) {
    return 'low';
  }
  return 'very-low';
}

function confidenceRecommendation(normalized, rejectedCount = 0) {
  if (Number(rejectedCount || 0) > 0 || clampNumber(normalized) < 0.45) {
    return 'manual-review';
  }
  if (clampNumber(normalized) >= 0.9) {
    return 'auto-apply';
  }
  return 'review-first';
}

function buildConfidence(normalized, summary, rejectedCount = 0) {
  const value = clampNumber(normalized);
  return {
    score: Math.round(value * 100),
    normalized: roundNumber(value),
    label: confidenceLabel(value),
    recommendation: confidenceRecommendation(value, rejectedCount),
    summary: String(summary || '').trim(),
  };
}

function describeMatchMode(matchMode) {
  if (matchMode === 'exact') {
    return 'exact context';
  }
  if (matchMode === 'trim-end') {
    return 'trim-end fuzzy context';
  }
  if (matchMode === 'trimmed') {
    return 'trimmed fuzzy context';
  }
  if (matchMode === 'insert') {
    return 'insert-only context';
  }
  if (matchMode === 'none') {
    return 'unmatched context';
  }
  return String(matchMode || 'context match').trim() || 'context match';
}

function parseUnifiedDiff(patchText) {
  const payload = stripCodeFences(patchText);
  const lines = String(payload || '').replace(/\r\n/g, '\n').split('\n');
  const patches = [];
  let currentFile = null;
  let currentHunk = null;

  function pushHunk() {
    if (currentFile && currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    currentHunk = null;
  }

  function pushFile() {
    pushHunk();
    if (currentFile && (currentFile.oldPath || currentFile.newPath || currentFile.hunks.length > 0)) {
      patches.push(currentFile);
    }
    currentFile = null;
  }

  for (const line of lines) {
    if (/^diff --git /.test(line)) {
      pushFile();
      currentFile = createFilePatch();
      currentFile.header = line;
      continue;
    }
    if (/^--- /.test(line)) {
      pushHunk();
      if (!currentFile) {
        currentFile = createFilePatch();
      }
      currentFile.oldPath = normalizePatchPath(line.slice(4));
      continue;
    }
    if (/^\+\+\+ /.test(line)) {
      if (!currentFile) {
        currentFile = createFilePatch();
      }
      currentFile.newPath = normalizePatchPath(line.slice(4));
      continue;
    }
    if (/^@@ /.test(line)) {
      if (!currentFile) {
        currentFile = createFilePatch();
      }
      pushHunk();
      const parsed = parseHunkHeader(line);
      if (!parsed) {
        throw new Error(`Invalid hunk header: ${line}`);
      }
      currentHunk = {
        header: line,
        ...parsed,
        lines: [],
      };
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    if (/^[ +\\-]/.test(line)) {
      if (line.startsWith('\\')) {
        continue;
      }
      currentHunk.lines.push({
        kind: line[0],
        text: line.slice(1),
      });
    }
  }

  pushFile();
  return patches;
}

function lineSimilarity(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) {
    return 3;
  }
  if (a.trimEnd() === b.trimEnd()) {
    return 2;
  }
  if (a.trim() === b.trim()) {
    return 1;
  }
  return 0;
}

function evaluateSequenceMatch(lines, start, sequence, minSimilarity) {
  if (start < 0 || start + sequence.length > lines.length) {
    return null;
  }
  let score = 0;
  let exactMatches = 0;
  let fuzzyMatches = 0;
  for (let index = 0; index < sequence.length; index += 1) {
    const similarity = lineSimilarity(lines[start + index], sequence[index]);
    if (similarity < minSimilarity) {
      return null;
    }
    score += similarity;
    if (similarity === 3) {
      exactMatches += 1;
    } else {
      fuzzyMatches += 1;
    }
  }
  return {
    index: start,
    score,
    exactMatches,
    fuzzyMatches,
  };
}

function buildCandidateOrder(maxStart, expectedStart, neighborhood = 80) {
  const ordered = [];
  const seen = new Set();
  const clampedExpected = Math.min(maxStart, Math.max(0, expectedStart));
  for (let distance = 0; distance <= neighborhood; distance += 1) {
    for (const candidate of [clampedExpected - distance, clampedExpected + distance]) {
      if (candidate < 0 || candidate > maxStart || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      ordered.push(candidate);
    }
  }
  for (let index = 0; index <= maxStart; index += 1) {
    if (seen.has(index)) {
      continue;
    }
    ordered.push(index);
  }
  return ordered;
}

function findBestSequenceMatch(lines, sequence, expectedStart) {
  if (sequence.length === 0) {
    return {
      index: Math.min(lines.length, Math.max(0, expectedStart)),
      score: 0,
      exactMatches: 0,
      fuzzyMatches: 0,
      matchMode: 'insert',
      distance: 0,
    };
  }

  const maxStart = Math.max(0, lines.length - sequence.length);
  const candidates = buildCandidateOrder(maxStart, expectedStart);
  for (const minSimilarity of [3, 2, 1]) {
    let best = null;
    for (const candidate of candidates) {
      const evaluation = evaluateSequenceMatch(lines, candidate, sequence, minSimilarity);
      if (!evaluation) {
        continue;
      }
      const distance = Math.abs(candidate - expectedStart);
      const contender = {
        ...evaluation,
        distance,
        matchMode: minSimilarity === 3 ? 'exact' : minSimilarity === 2 ? 'trim-end' : 'trimmed',
      };
      if (
        !best
        || contender.score > best.score
        || (contender.score === best.score && contender.distance < best.distance)
      ) {
        best = contender;
      }
    }
    if (best) {
      return best;
    }
  }

  return null;
}

function scoreHunkResult(hunkResult) {
  const status = String(hunkResult?.status || '').trim().toLowerCase();
  const matchMode = String(hunkResult?.matchMode || '').trim().toLowerCase();
  const lineCount = Math.max(1, Number(hunkResult?.lineCount || 0));
  const exactMatches = Math.max(0, Number(hunkResult?.exactMatches || 0));
  const fuzzyMatches = Math.max(0, Number(hunkResult?.fuzzyMatches || 0));
  const distance = Math.max(0, Number(hunkResult?.distance || 0));
  const totalMatches = Math.max(1, exactMatches + fuzzyMatches);

  if (status === 'rejected') {
    return buildConfidence(0.05, 'Hunk could not be matched to the target file.', 1);
  }

  const scoreTable = {
    applied: {
      exact: 0.99,
      'trim-end': 0.9,
      trimmed: 0.78,
      insert: 0.74,
    },
    'already-applied': {
      exact: 0.9,
      'trim-end': 0.84,
      trimmed: 0.72,
      insert: 0.7,
    },
  };
  let normalized = scoreTable[status]?.[matchMode] ?? 0.6;
  normalized -= Math.min(0.18, distance * 0.02);
  normalized -= Math.min(0.12, (fuzzyMatches / totalMatches) * 0.12);
  if (status === 'already-applied') {
    normalized -= 0.02;
  }
  if (matchMode === 'exact' && distance === 0 && fuzzyMatches === 0) {
    normalized += 0.01;
  }
  const confidence = buildConfidence(
    normalized,
    `${status === 'already-applied' ? 'Patch already present with' : 'Hunk matched using'} ${describeMatchMode(matchMode)}${distance > 0 ? ` ${distance} line(s) away from expected location` : ''}.`,
  );
  return {
    ...confidence,
    lineCount,
  };
}

function buildFileConfidence(fileResult) {
  const hunks = Array.isArray(fileResult?.hunks) ? fileResult.hunks : [];
  const weights = hunks.map((item) => Math.max(1, Number(item?.lineCount || 1)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const weightedScore = totalWeight > 0
    ? hunks.reduce((sum, item, index) => sum + (Number(item?.confidence?.normalized || 0) * weights[index]), 0) / totalWeight
    : 0.55;
  let normalized = weightedScore;

  if (fileResult?.operation === 'delete') {
    normalized -= 0.05;
  }
  if (fileResult?.operation === 'add') {
    normalized -= 0.03;
  }
  if (!fileResult?.ok) {
    normalized = Math.min(normalized, 0.35);
  }
  if (!String(fileResult?.path || '').trim()) {
    normalized = 0;
  }

  const appliedHunks = hunks.filter((item) => item.status === 'applied').length;
  const alreadyAppliedHunks = hunks.filter((item) => item.status === 'already-applied').length;
  const rejectedHunks = hunks.filter((item) => item.status === 'rejected').length;
  const summary = rejectedHunks > 0
    ? `${rejectedHunks} hunk(s) rejected for ${fileResult.path || 'this file'}.`
    : (appliedHunks > 0
        ? `${appliedHunks} hunk(s) matched for ${fileResult.path || 'this file'}.`
        : `${alreadyAppliedHunks} hunk(s) were already present in ${fileResult.path || 'this file'}.`);
  return buildConfidence(normalized, summary, rejectedHunks);
}

function buildPatchConfidence(fileResults) {
  const results = Array.isArray(fileResults) ? fileResults : [];
  const weights = results.map((item) => Math.max(1, Number(item?.hunks?.length || 0)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const weightedScore = totalWeight > 0
    ? results.reduce((sum, item, index) => sum + (Number(item?.confidence?.normalized || 0) * weights[index]), 0) / totalWeight
    : 0;
  const rejectedHunkCount = results.reduce((sum, item) => sum + Number(item?.rejects?.length || 0), 0);
  const appliedFileCount = results.filter((item) => item?.hunks?.some((hunk) => hunk.status === 'applied')).length;
  const alreadyAppliedFileCount = results.filter((item) => item?.hunks?.every((hunk) => hunk.status === 'already-applied')).length;
  let normalized = weightedScore;
  if (rejectedHunkCount > 0) {
    normalized = Math.min(normalized, 0.35);
  }
  const summary = rejectedHunkCount > 0
    ? `Patch needs manual review because ${rejectedHunkCount} hunk(s) were rejected.`
    : (appliedFileCount > 0
        ? `Patch matched cleanly across ${appliedFileCount} file(s).`
        : `Patch content already appears to be applied across ${alreadyAppliedFileCount} file(s).`);
  return buildConfidence(normalized, summary, rejectedHunkCount);
}

function resolveOperation(filePatch) {
  if (filePatch.oldPath === '/dev/null') {
    return 'add';
  }
  if (filePatch.newPath === '/dev/null') {
    return 'delete';
  }
  return 'modify';
}

function resolveTargetPath(workspaceRoot, filePatch) {
  const relativePath = resolveOperation(filePatch) === 'delete' ? filePatch.oldPath : filePatch.newPath;
  const normalized = normalizePatchPath(relativePath);
  if (!normalized || normalized === '/dev/null') {
    return { ok: false, reason: 'Patch did not include a writable file path.' };
  }
  const absolutePath = path.resolve(workspaceRoot, normalized);
  if (!isWithin(workspaceRoot, absolutePath)) {
    return { ok: false, reason: `Patch path escapes workspace: ${normalized}` };
  }
  return {
    ok: true,
    relativePath: normalized,
    absolutePath,
  };
}

function readFileState(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      lines: [],
      endsWithNewline: true,
    };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = splitContentLines(raw);
  return {
    exists: true,
    lines: parsed.lines,
    endsWithNewline: parsed.endsWithNewline,
  };
}

function applyFilePatch(filePatch, workspaceRoot) {
  const target = resolveTargetPath(workspaceRoot, filePatch);
  if (!target.ok) {
    const fileResult = {
      ok: false,
      path: '',
      operation: resolveOperation(filePatch),
      hunks: [],
      rejects: [{
        path: '',
        header: '',
        reason: target.reason,
      }],
    };
    fileResult.confidence = buildConfidence(0, target.reason, fileResult.rejects.length);
    return fileResult;
  }

  const operation = resolveOperation(filePatch);
  const current = readFileState(target.absolutePath);
  if ((operation === 'modify' || operation === 'delete') && !current.exists) {
    const fileResult = {
      ok: false,
      path: target.relativePath,
      operation,
      hunks: [],
      rejects: [{
        path: target.relativePath,
        header: '',
        reason: 'Target file does not exist.',
      }],
    };
    fileResult.confidence = buildConfidence(0, `Target file does not exist: ${target.relativePath}`, fileResult.rejects.length);
    return fileResult;
  }

  let lines = current.lines.slice();
  let offset = 0;
  const hunkResults = [];
  const rejects = [];

  for (const hunk of filePatch.hunks) {
    const originalSequence = hunk.lines
      .filter((line) => line.kind !== '+')
      .map((line) => line.text);
    const updatedSequence = hunk.lines
      .filter((line) => line.kind !== '-')
      .map((line) => line.text);
    const lineCount = Math.max(1, hunk.lines.length, originalSequence.length, updatedSequence.length);
    const expectedStart = Math.max(0, (Number(hunk.oldStart || 1) - 1) + offset);
    const match = findBestSequenceMatch(lines, originalSequence, expectedStart);

    if (!match) {
      const alreadyApplied = originalSequence.join('\n') !== updatedSequence.join('\n')
        ? findBestSequenceMatch(lines, updatedSequence, expectedStart)
        : null;
      if (alreadyApplied && alreadyApplied.distance <= 3) {
        const hunkResult = {
          header: hunk.header,
          status: 'already-applied',
          index: alreadyApplied.index,
          matchMode: alreadyApplied.matchMode,
          exactMatches: alreadyApplied.exactMatches,
          fuzzyMatches: alreadyApplied.fuzzyMatches,
          distance: alreadyApplied.distance,
          lineCount,
        };
        hunkResult.confidence = scoreHunkResult(hunkResult);
        hunkResults.push(hunkResult);
        continue;
      }
      rejects.push({
        path: target.relativePath,
        header: hunk.header,
        reason: 'Unable to match hunk context.',
      });
      const hunkResult = {
        header: hunk.header,
        status: 'rejected',
        index: -1,
        matchMode: 'none',
        distance: -1,
        lineCount,
      };
      hunkResult.confidence = scoreHunkResult(hunkResult);
      hunkResults.push(hunkResult);
      continue;
    }

    const matchedSlice = lines.slice(match.index, match.index + originalSequence.length);
    const replacement = [];
    let matchedCursor = 0;

    for (const line of hunk.lines) {
      if (line.kind === ' ') {
        replacement.push(matchedSlice[matchedCursor] ?? line.text);
        matchedCursor += 1;
        continue;
      }
      if (line.kind === '-') {
        matchedCursor += 1;
        continue;
      }
      if (line.kind === '+') {
        replacement.push(line.text);
      }
    }

    lines = [
      ...lines.slice(0, match.index),
      ...replacement,
      ...lines.slice(match.index + originalSequence.length),
    ];
    offset += replacement.length - originalSequence.length;
    const hunkResult = {
      header: hunk.header,
      status: 'applied',
      index: match.index,
      matchMode: match.matchMode,
      exactMatches: match.exactMatches,
      fuzzyMatches: match.fuzzyMatches,
      distance: match.distance,
      lineCount,
    };
    hunkResult.confidence = scoreHunkResult(hunkResult);
    hunkResults.push(hunkResult);
  }

  const fileResult = {
    ok: rejects.length === 0,
    path: target.relativePath,
    absolutePath: target.absolutePath,
    operation,
    existed: current.exists,
    hunks: hunkResults,
    rejects,
    nextState: {
      exists: operation === 'delete' ? false : true,
      lines,
      endsWithNewline: current.exists ? current.endsWithNewline : true,
    },
  };
  fileResult.confidence = buildFileConfidence(fileResult);

  return fileResult;
}

function writeFileState(fileResult) {
  const nextState = fileResult.nextState || {};
  if (fileResult.operation === 'delete') {
    if (fs.existsSync(fileResult.absolutePath)) {
      fs.rmSync(fileResult.absolutePath, { force: true });
    }
    return;
  }
  ensureDirectory(path.dirname(fileResult.absolutePath));
  fs.writeFileSync(
    fileResult.absolutePath,
    joinContentLines(nextState.lines || [], nextState.endsWithNewline !== false),
    'utf8',
  );
}

function summarizeFileResult(fileResult) {
  const appliedHunks = fileResult.hunks.filter((item) => item.status === 'applied').length;
  const alreadyApplied = fileResult.hunks.filter((item) => item.status === 'already-applied').length;
  const rejected = fileResult.hunks.filter((item) => item.status === 'rejected').length;
  return {
    path: fileResult.path,
    operation: fileResult.operation,
    status: fileResult.ok ? (appliedHunks > 0 ? 'applied' : (alreadyApplied > 0 ? 'already-applied' : 'noop')) : 'rejected',
    appliedHunks,
    alreadyAppliedHunks: alreadyApplied,
    rejectedHunks: rejected,
    matchModes: Array.from(new Set(fileResult.hunks.map((item) => item.matchMode).filter(Boolean))),
    confidence: fileResult.confidence || buildConfidence(0, 'No confidence available.', rejected),
    hunks: fileResult.hunks.map((item) => ({
      header: item.header,
      status: item.status,
      matchMode: item.matchMode,
      lineCount: Number(item.lineCount || 0),
      distance: Number(item.distance || 0),
      confidence: item.confidence || buildConfidence(0, 'No confidence available.'),
    })),
  };
}

function applySmartPatch(options = {}) {
  const workspaceRoot = path.resolve(String(options.workspaceRoot || process.cwd()).trim());
  const patchText = String(options.patchText || '').trim();
  const dryRun = options.dryRun !== false;
  const allowPartial = options.allowPartial === true;

  if (!patchText) {
    return {
      ok: false,
      dryRun,
      message: 'Patch text is required.',
      confidence: buildConfidence(0, 'Patch text is required.', 1),
      files: [],
      rejects: [],
    };
  }

  let filePatches;
  try {
    filePatches = parseUnifiedDiff(patchText);
  } catch (error) {
    return {
      ok: false,
      dryRun,
      message: error instanceof Error ? error.message : 'Unable to parse patch text.',
      confidence: buildConfidence(0, 'Patch text could not be parsed.', 1),
      files: [],
      rejects: [],
    };
  }

  if (!Array.isArray(filePatches) || filePatches.length === 0) {
    return {
      ok: false,
      dryRun,
      message: 'No unified-diff file patches were found.',
      confidence: buildConfidence(0, 'No unified diff file patches were found.', 1),
      files: [],
      rejects: [],
    };
  }

  const fileResults = filePatches.map((filePatch) => applyFilePatch(filePatch, workspaceRoot));
  const rejects = fileResults.flatMap((fileResult) => fileResult.rejects || []);
  const ok = rejects.length === 0;
  const writableResults = fileResults.filter((fileResult) => fileResult.ok || allowPartial);

  if (!dryRun && (ok || allowPartial)) {
    for (const fileResult of writableResults) {
      if (fileResult.ok) {
        writeFileState(fileResult);
      }
    }
  }

  const summaries = fileResults.map((fileResult) => summarizeFileResult(fileResult));
  const appliedFileCount = summaries.filter((item) => item.appliedHunks > 0).length;
  const alreadyAppliedFileCount = summaries.filter((item) => item.alreadyAppliedHunks > 0 && item.appliedHunks === 0).length;
  const confidence = buildPatchConfidence(fileResults);

  return {
    ok,
    dryRun,
    allowPartial,
    workspaceRoot,
    fileCount: fileResults.length,
    appliedFileCount,
    alreadyAppliedFileCount,
    rejectedHunkCount: rejects.length,
    confidence,
    automationScore: confidence.score,
    automationRecommendation: confidence.recommendation,
    message: ok
      ? (dryRun
          ? `Patch can be applied to ${appliedFileCount} file(s).`
          : `Patch applied to ${appliedFileCount} file(s).`)
      : `Patch rejected with ${rejects.length} hunk problem(s).`,
    files: summaries,
    rejects,
  };
}

module.exports = {
  applySmartPatch,
  parseUnifiedDiff,
};
