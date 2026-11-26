/** An environment variable the target reads when it starts the server; never a value. */
export interface SecretRef {
  secret: string;
}

/** Text, or text with secret references in it, joined in order. */
export type Value = string | readonly (string | SecretRef)[];

export type RemoteTransport = "streamable-http" | "sse";
export type Transport = "stdio" | RemoteTransport;

interface StdioEntry {
  transport: "stdio";
  command: string;
  args: Value[];
  env: Record<string, Value>;
}

interface RemoteEntry {
  transport: RemoteTransport;
  url: Value;
  headers: Record<string, Value>;
}

export type McpEntry = StdioEntry | RemoteEntry;

/** One way to run the server, and the environment variables it needs set. */
export interface McpOption {
  entry: McpEntry;
  secrets: string[];
}

/** Per project, from the manifest: input values, and a secret's variable renamed. */
export interface McpSettings {
  with?: Readonly<Record<string, string | readonly string[]>> | undefined;
  env?: Readonly<Record<string, string>> | undefined;
  /** Writes a required input nothing sets as `<name>`, for showing the server, never installing it. */
  placeholders?: boolean | undefined;
}

/** Every way the server can run here, remotes first, and why the others cannot. */
export interface Resolved {
  options: McpOption[];
  leftOut: string[];
}
