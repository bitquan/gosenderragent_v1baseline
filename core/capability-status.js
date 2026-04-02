'use strict';

const VERIFIED_STATUSES = new Set(['verified', 'pass', 'ready', 'green', 'open', 'strong', 'triggered', 'proven']);
const CANDIDATE_STATUSES = new Set(['warn', 'partial', 'next', 'caution', 'recorded', 'candidate', 'current']);
const BLOCKED_STATUSES = new Set(['fail', 'blocked', 'error', 'needs-repair', 'cancelled']);
const MISSING_STATUSES = new Set(['', 'missing', 'idle', 'locked', 'unavailable', 'not-ready', 'unknown']);

const VERIFIED_LABELS = new Set(['VERIFIED', 'PASS', 'READY', 'PROVEN']);
const CANDIDATE_LABELS = new Set(['PARTIAL', 'WARN', 'CAUTION', 'RECORDED', 'NEXT', 'CANDIDATE']);
const BLOCKED_LABELS = new Set(['BLOCKED', 'FAIL', 'ERROR']);
const MISSING_LABELS = new Set(['NOT RUN', 'NOT READY', 'MISSING', 'IDLE', 'LOCKED', 'UNAVAILABLE', 'UNKNOWN']);

function normalizeValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLabel(value) {
  return String(value || '').trim().toUpperCase();
}

function capabilityLabelForState(state = '') {
  const normalized = normalizeValue(state);
  if (normalized === 'verified') {
    return 'VERIFIED';
  }
  if (normalized === 'candidate') {
    return 'CANDIDATE-ONLY';
  }
  if (normalized === 'blocked') {
    return 'BLOCKED';
  }
  return 'MISSING';
}

function normalizeCapabilityState(input = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const explicitState = normalizeValue(payload.capabilityState);
  if (['verified', 'candidate', 'blocked', 'missing'].includes(explicitState)) {
    return explicitState;
  }

  const status = normalizeValue(payload.status);
  const label = normalizeLabel(payload.label);
  const exists = payload.exists !== false;

  if (payload.blocked === true || BLOCKED_STATUSES.has(status) || BLOCKED_LABELS.has(label)) {
    return 'blocked';
  }
  if (payload.proven === true || payload.verified === true || VERIFIED_STATUSES.has(status) || VERIFIED_LABELS.has(label)) {
    return 'verified';
  }
  if (payload.partial === true || CANDIDATE_STATUSES.has(status) || CANDIDATE_LABELS.has(label)) {
    return 'candidate';
  }
  if (!exists || MISSING_STATUSES.has(status) || MISSING_LABELS.has(label)) {
    return 'missing';
  }
  if (status || label) {
    return 'candidate';
  }
  return 'missing';
}

function buildCapabilityDescriptor(input = {}) {
  const capabilityState = normalizeCapabilityState(input);
  return {
    capabilityState,
    capabilityLabel: capabilityLabelForState(capabilityState),
  };
}

module.exports = {
  buildCapabilityDescriptor,
  capabilityLabelForState,
  normalizeCapabilityState,
};