import { describe, expect, it } from "vitest";
import { registryNameFromLocation } from "#adapter/index.ts";
import { parseSource, SourceParseError, sshUrl } from "./url.ts";

describe("parseSource", () => {
  it("reads owner/repo as an address, not a repository", () => {
    expect(() => parseSource("acme/agent-skills")).toThrow(
      expect.objectContaining({ hint: "Name the host too, such as github.com/owner/repo." }),
    );
    expect(parseSource("github.com/acme/agent-skills")).toMatchObject({
      location: "https://github.com/acme/agent-skills.git",
      kind: "git",
      alias: "agent-skills",
      slug: "acme/agent-skills",
      host: "github.com",
    });
  });

  it("takes a ref after the final slash", () => {
    expect(parseSource("github.com/acme/kit@v2.1.0").ref).toBe("v2.1.0");
    expect(parseSource("https://github.com/acme/kit@main").ref).toBe("main");
  });

  it("does not mistake the user in an SSH URL for a ref", () => {
    const spec = parseSource("git@github.com:acme/kit.git");
    expect(spec.ref).toBeUndefined();
    expect(spec.slug).toBe("acme/kit");
    expect(spec.location).toBe("git@github.com:acme/kit.git");
  });

  it("still finds a ref on an SSH URL", () => {
    expect(parseSource("git@github.com:acme/kit.git@v1").ref).toBe("v1");
  });

  it("treats a bare path as a directory and file:// as a clone", () => {
    expect(parseSource("./kit", "/work").kind).toBe("path");
    expect(parseSource("/abs/kit").kind).toBe("path");
    expect(parseSource("file:///abs/kit").kind).toBe("git");
  });

  it("rejects ext::, which runs an arbitrary command", () => {
    expect(() => parseSource("ext::sh -c whoami")).toThrow(SourceParseError);
  });

  it("names the right syntax when given the other tool's", () => {
    expect(() => parseSource("acme/kit#v1")).toThrow(
      expect.objectContaining({ hint: "Name a branch or tag with `@ref`, not `#ref`." }),
    );
  });

  it("refuses a ref on a local path, which cannot have one", () => {
    expect(() => parseSource("./kit@v1", "/work")).toThrow(SourceParseError);
  });
});

describe("an ssh:// address", () => {
  it("is cloned as written, with its user, host and port", () => {
    expect(parseSource("ssh://example.com/acme/kit")).toMatchObject({
      location: "ssh://example.com/acme/kit.git",
      slug: "acme/kit",
      host: "example.com",
    });
    expect(parseSource("ssh://git@github.com/acme/kit.git")).toMatchObject({
      location: "ssh://git@github.com/acme/kit.git",
      slug: "acme/kit",
      host: "github.com",
    });
    expect(parseSource("ssh://git@example.com:2222/acme/kit@v1")).toMatchObject({
      location: "ssh://git@example.com:2222/acme/kit.git",
      ref: "v1",
      slug: "acme/kit",
      host: "example.com",
    });
  });
});

describe("the alias a source is named by", () => {
  it("is the one any adapter's source would get", () => {
    for (const location of ["https://example.com/Acme/Team_Kit.git", "/src/Kit/"]) {
      expect(parseSource(location).alias).toBe(registryNameFromLocation(location, "registry"));
    }
  });
});

describe("sshUrl", () => {
  it("converts an HTTPS clone URL for the auth fallback", () => {
    expect(sshUrl(parseSource("github.com/acme/kit"))).toBe("git@github.com:acme/kit.git");
  });
});

describe("an scp-style address", () => {
  it("keeps the user it names", () => {
    expect(parseSource("org-123@github.com:acme/kit.git").location).toBe(
      "org-123@github.com:acme/kit.git",
    );
  });
});
