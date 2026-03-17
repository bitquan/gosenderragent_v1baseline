---
component_name: {{ component_name }}
files:
  - frontend/apps/customer-app/src/components/{{ component_name }}.tsx
  - frontend/apps/customer-app/src/services/{{ snake }}.ts
  - frontend/apps/customer-app/src/routes/{{ snake }}.tsx
  - frontend/apps/customer-app/src/__tests__/{{ component_name }}.test.tsx
---
{{#if is_fe}}
{{#for file in files}}
# --- {{file}} ---
// generated for BAT<{{ ticket_id }}>: {{ desc }}
export const bat{{ ticket_id }} = true;

{{/for}}
{{#else}}
# --- backend/tests/test_{{ snake }}_frontend_template_guard.py ---
# template selected for non-FE BAT; verify before writing.
def test_frontend_template_guard() -> None:
    assert False, "frontend_bundle template used for non-FE BAT"
{{/if}}
