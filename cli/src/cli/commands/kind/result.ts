/** `aireg <kind> new`; `todo` names the fields left as placeholders. */
export interface KindNew {
  kind: string;
  name: string;
  created: string[];
  todo: string[];
}

/** `aireg <kind> new --from`; `at` is each copy's path in the registry. */
export interface KindNewFrom {
  kind: string;
  namespace: string;
  created: { name: string; at: string }[];
}

export type KindNewResult = KindNew | KindNewFrom;

export interface KindBump {
  kind: string;
  name: string;
  from: string;
  to: string;
}
