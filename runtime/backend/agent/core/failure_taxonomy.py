from __future__ import annotations

from collections import Counter
from typing import Any


_FAILURE_DESCRIPTORS: dict[str, dict[str, str]] = {
    "missing-fixture-client": {
        "failure_family": "baseline-setup",
        "repair_reason_code": "missing_fixture_client",
        "operator_action": "restore or create the missing test fixture before retrying runtime changes",
    },
    "unrelated-failing-test-selection": {
        "failure_family": "validation-scope",
        "repair_reason_code": "unrelated_test_selection",
        "operator_action": "narrow validation scope to the intended task boundary",
    },
    "migration-revision-missing": {
        "failure_family": "baseline-state",
        "repair_reason_code": "migration_revision_missing",
        "operator_action": "repair migration state before attempting another bounded patch",
    },
    "import-setup-failure": {
        "failure_family": "import-setup",
        "repair_reason_code": "import_setup_failure",
        "operator_action": "restore missing imports or dependency setup before retrying",
    },
    "assertion-failure": {
        "failure_family": "behavior-regression",
        "repair_reason_code": "assertion_failure",
        "operator_action": "repair the failing code path and rerun the targeted validation command",
    },
    "generic-validation-failure": {
        "failure_family": "generic-validation",
        "repair_reason_code": "generic_validation_failure",
        "operator_action": "inspect the first failing validation output and constrain the next repair boundary",
    },
}


def describe_failure_label(label: str, *, summary: str = "") -> dict[str, Any]:
    normalized = str(label or "").strip().lower() or "generic-validation-failure"
    descriptor = dict(_FAILURE_DESCRIPTORS.get(normalized) or _FAILURE_DESCRIPTORS["generic-validation-failure"])
    descriptor.update(
        {
            "label": normalized,
            "summary": str(summary or "").strip(),
        }
    )
    return descriptor


def summarize_failure_taxonomy(items: list[Any] | None = None) -> dict[str, Any]:
    family_counter: Counter[str] = Counter()
    reason_counter: Counter[str] = Counter()
    label_counter: Counter[str] = Counter()
    operator_actions: list[str] = []

    for item in list(items or []):
        if isinstance(item, dict):
            descriptor = describe_failure_label(
                str(item.get("label") or ""),
                summary=str(item.get("summary") or ""),
            )
        else:
            descriptor = describe_failure_label(str(item or ""))
        family = str(descriptor.get("failure_family") or "generic-validation")
        reason_code = str(descriptor.get("repair_reason_code") or "generic_validation_failure")
        label = str(descriptor.get("label") or "generic-validation-failure")
        operator_action = str(descriptor.get("operator_action") or "")
        family_counter[family] += 1
        reason_counter[reason_code] += 1
        label_counter[label] += 1
        if operator_action and operator_action not in operator_actions:
            operator_actions.append(operator_action)

    families = [{"family": family, "count": count} for family, count in family_counter.most_common()]
    reason_codes = [{"reason_code": code, "count": count} for code, count in reason_counter.most_common()]
    labels = [{"label": label, "count": count} for label, count in label_counter.most_common()]
    primary_failure_family = str(families[0]["family"] if families else "")
    primary_repair_reason_code = str(reason_codes[0]["reason_code"] if reason_codes else "")
    summary_parts: list[str] = []
    if primary_failure_family:
        summary_parts.append(f"primary failure family: {primary_failure_family}")
    if primary_repair_reason_code:
        summary_parts.append(f"repair reason: {primary_repair_reason_code}")
    if labels:
        summary_parts.append(f"top label: {labels[0]['label']}")
    return {
        "families": families,
        "reason_codes": reason_codes,
        "labels": labels,
        "primary_failure_family": primary_failure_family,
        "primary_repair_reason_code": primary_repair_reason_code,
        "operator_actions": operator_actions,
        "summary": "; ".join(summary_parts),
    }


def summarize_repair_outcomes(
    repairs: list[dict[str, Any]] | None = None,
    *,
    failure_family: str = "",
    repair_reason_code: str = "",
    validation_ok: bool = False,
) -> dict[str, Any]:
    rows = [dict(item) for item in list(repairs or []) if isinstance(item, dict)]
    attempted_paths = [str(item.get("path") or "") for item in rows if str(item.get("path") or "")]
    applied_count = sum(1 for item in rows if str(item.get("status") or "") == "applied")
    skipped_count = sum(1 for item in rows if str(item.get("status") or "") == "skipped")
    status = "succeeded" if validation_ok else ("attempted" if applied_count else ("skipped" if skipped_count else "not-started"))
    operator_summary = "No repair attempt was recorded."
    if validation_ok and applied_count:
        operator_summary = f"Applied {applied_count} repair patch(es) and validation recovered."
    elif applied_count:
        operator_summary = f"Applied {applied_count} repair patch(es), but validation still needs follow-up."
    elif skipped_count:
        operator_summary = f"Skipped {skipped_count} repair patch attempt(s); manual triage is likely required."
    return {
        "status": status,
        "failure_family": str(failure_family or ""),
        "repair_reason_code": str(repair_reason_code or ""),
        "applied_count": int(applied_count),
        "skipped_count": int(skipped_count),
        "attempted_paths": attempted_paths,
        "validation_ok": bool(validation_ok),
        "operator_summary": operator_summary,
    }
