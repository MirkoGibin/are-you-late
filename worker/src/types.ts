export type Leg = "outbound" | "return";

export interface Station {
  code: string;
  label: string;
}

export interface RouteConfig {
  switchTime: string; // "HH:MM", Europe/Rome
  outbound: {
    train: string;
    origin: Station;
    checkpoint: Station;
    userStop: { label: string; offsetMin: number; scheduled: string };
  };
  return: {
    train: string;
    origin: Station;
    userStop: Station & { scheduled: string };
  };
  thresholds: { passedGraceMin: number; returnYellowDelayMin: number };
}

export interface StopRecord {
  code: string;
  scheduledMs: number;
  actualMs: number | null;
  cancelled: boolean;
}

export interface Train {
  delayMin: number;
  cancelled: boolean;
  stops: StopRecord[];
}

export type Color = "grey" | "yellow" | "red" | "green";

export interface StopView {
  name: string;
  time: string;
  kind: "detected" | "estimate" | "scheduled";
  state: "passed" | "next" | "target" | "pending";
  scheduled?: string;
}

export interface StatusResponse {
  ok: boolean;
  direction?: Leg;
  delay_min?: number;
  light: { color: Color; title: string; subtitle: string };
  stops?: StopView[];
  moving_after?: string | null;
  updated_at: string; // ISO 8601, UTC
}
