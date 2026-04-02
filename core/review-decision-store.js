'use strict';

const fs = require('fs');
const path = require('path');

const { getAssistantRunsDir } = require('./assistant-paths');
const { normalizeReviewDecisions } = require('./review-approval-state');

function getReviewDecisionStatePath(workspaceRoot) {
    const runsDir = getAssistantRunsDir(workspaceRoot);
    return runsDir ? path.join(runsDir, 'review_decisions.json') : '';
}

function readStoredReviewDecisions(workspaceRoot, options = {}) {
    const filePath = getReviewDecisionStatePath(workspaceRoot);
    const fallbackDecisions = options.fallbackDecisions && typeof options.fallbackDecisions === 'object'
        ? options.fallbackDecisions
        : {};
    const normalizedFallback = normalizeReviewDecisions(fallbackDecisions, options);
    if (!filePath || !fs.existsSync(filePath)) {
        return {
            exists: false,
            path: filePath,
            decisions: normalizedFallback,
        };
    }

    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const persisted = raw?.decisions && typeof raw.decisions === 'object'
            ? raw.decisions
            : (raw && typeof raw === 'object' ? raw : {});
        return {
            exists: true,
            path: filePath,
            decisions: normalizeReviewDecisions({
                ...normalizedFallback,
                ...persisted,
            }, options),
        };
    } catch (_error) {
        return {
            exists: false,
            path: filePath,
            decisions: normalizedFallback,
        };
    }
}

function writeStoredReviewDecisions(workspaceRoot, decisions = {}, options = {}) {
    const filePath = getReviewDecisionStatePath(workspaceRoot);
    const normalized = normalizeReviewDecisions(decisions, options);
    if (!filePath) {
        return {
            ok: false,
            path: '',
            decisions: normalized,
        };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        decisions: normalized,
    }, null, 2)}\n`, 'utf8');
    return {
        ok: true,
        path: filePath,
        decisions: normalized,
    };
}

module.exports = {
    getReviewDecisionStatePath,
    readStoredReviewDecisions,
    writeStoredReviewDecisions,
};