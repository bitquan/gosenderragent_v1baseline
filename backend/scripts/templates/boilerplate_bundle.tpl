{{#for file in files}}
# --- {{file}} ---
{{#if is_fe}}
// generated for BAT<{{ ticket_id }}>: {{ desc }}
export const placeholder = "BAT {{ ticket_id }}";
{{#else}}
# generated for BAT<{{ ticket_id }}>: {{ desc }}
from __future__ import annotations

def placeholder_{{ ticket_id }}() -> dict:
    return {"status": "todo", "ticket": "{{ ticket_id }}"}
{{/if}}

{{/for}}
