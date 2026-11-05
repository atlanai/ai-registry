import { StringDecoder } from "node:string_decoder";
import { parseMessage, type RpcMessage } from "./protocol.ts";

export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_FRAME_SHOWN = `${MAX_RPC_FRAME_BYTES / (1024 * 1024)} MiB`;

export class FrameDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #peer: string;
  #buffer = "";
  #bytes = 0;

  constructor(peer: string) {
    this.#peer = peer;
  }

  push(chunk: Uint8Array): RpcMessage[] {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_RPC_FRAME_BYTES && !chunk.includes(10)) {
      throw new Error(
        `A message from ${this.#peer} is larger than the ${MAX_RPC_FRAME_SHOWN} limit.`,
      );
    }
    this.#buffer += this.#decoder.write(Buffer.from(chunk));
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    this.#bytes = Buffer.byteLength(this.#buffer);
    if (lines.some((line) => Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES)) {
      throw new Error(
        `A message from ${this.#peer} is larger than the ${MAX_RPC_FRAME_SHOWN} limit.`,
      );
    }
    return lines.filter((line) => line.trim() !== "").map(parseMessage);
  }

  end(): void {
    this.#buffer += this.#decoder.end();
    if (this.#buffer.trim() !== "")
      throw new Error("The connection ended in the middle of a message.");
  }
}
