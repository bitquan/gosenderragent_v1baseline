# --- {{model_file}} ---
import React from "react";

export type {{component_name}}CardProps = {
  title?: string;
  subtitle?: string;
};

export function {{component_name}}Card({
  title = "BAT<{{ticket_id}}> Feature",
  subtitle = "{{desc}}",
}: {{component_name}}CardProps) {
  return (
    <section style={{ border: "1px solid #d4dce8", borderRadius: 12, padding: 12, background: "#fff" }}>
      <h3 style={{ margin: 0, fontSize: "1rem" }}>{title}</h3>
      <p style={{ marginTop: 6, color: "#4b6078" }}>{subtitle}</p>
    </section>
  );
}

export default {{component_name}}Card;


# --- {{service_file}} ---
export type {{component_name}}Payload = {
  ticket: string;
  status: "ready";
  detail: string;
};

export async function fetch{{component_name}}Payload(): Promise<{{component_name}}Payload> {
  return {
    ticket: "{{ticket_id}}",
    status: "ready",
    detail: "{{desc}}",
  };
}


# --- {{route_file}} ---
import React, { useEffect, useState } from "react";

import {{component_name}}Card from "../components/{{component_name}}";
import { fetch{{component_name}}Payload } from "../services/{{snake}}";

export default function {{component_name}}Route() {
  const [detail, setDetail] = useState<string>("Loading...");

  useEffect(() => {
    let mounted = true;
    fetch{{component_name}}Payload().then((payload) => {
      if (mounted) setDetail(payload.detail);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return <{{component_name}}Card subtitle={detail} />;
}


# --- {{test_file}} ---
import { describe, expect, it } from "vitest";

import { fetch{{component_name}}Payload } from "../services/{{snake}}";

describe("BAT<{{ticket_id}}> {{component_name}} scaffold", () => {
  it("returns ready payload", async () => {
    const payload = await fetch{{component_name}}Payload();
    expect(payload.ticket).toBe("{{ticket_id}}");
    expect(payload.status).toBe("ready");
  });
});
