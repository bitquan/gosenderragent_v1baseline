'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getReviewDecisionStatePath,
    readStoredReviewDecisions,
    writeStoredReviewDecisions,
} = require('../core/review-decision-store');

test('review decision store persists and reloads workspace review decisions', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-review-store-'));
    fs.mkdirSync(path.join(workspaceRoot, 'docs', 'assistant_runs'), { recursive: true });

    try {
        const written = writeStoredReviewDecisions(workspaceRoot, {
            'src/app.js': {
                status: 'approved',
                note: 'reviewed',
                updatedAt: '2026-04-01T00:00:00.000Z',
            },
        });

        assert.equal(written.ok, true);
        assert.equal(path.basename(getReviewDecisionStatePath(workspaceRoot)), 'review_decisions.json');
        assert.equal(fs.existsSync(written.path), true);

        const loaded = readStoredReviewDecisions(workspaceRoot);
        assert.equal(loaded.exists, true);
        assert.equal(loaded.decisions['src/app.js'].status, 'approved');
        assert.equal(loaded.decisions['src/app.js'].note, 'reviewed');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('review decision store merges persisted decisions over fallback decisions', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-review-store-merge-'));
    fs.mkdirSync(path.join(workspaceRoot, 'docs', 'assistant_runs'), { recursive: true });

    try {
        writeStoredReviewDecisions(workspaceRoot, {
            'src/app.js': {
                status: 'rejected',
                note: 'needs fixes',
                updatedAt: '2026-04-01T00:00:00.000Z',
            },
        });

        const loaded = readStoredReviewDecisions(workspaceRoot, {
            fallbackDecisions: {
                'src/app.js': {
                    status: 'approved',
                    note: 'older',
                    updatedAt: '2026-03-31T00:00:00.000Z',
                },
                'src/other.js': {
                    status: 'pending',
                    note: '',
                    updatedAt: '2026-03-31T00:00:00.000Z',
                },
            },
        });

        assert.equal(loaded.decisions['src/app.js'].status, 'rejected');
        assert.equal(loaded.decisions['src/app.js'].note, 'needs fixes');
        assert.equal(loaded.decisions['src/other.js'].status, 'pending');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});