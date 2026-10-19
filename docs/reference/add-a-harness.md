# Add a harness

aireg installs into the coding agents it builds in. For another agent, write a [harness file](harnesses.md#harness-files): a JSON document that says where that agent reads each kind. aireg reads it from `~/.aireg/harnesses/` and installs into the agent as it does into a built-in one.

## 1. Find where the agent reads each kind

From the agent's own documentation, note:

- the folder it reads in a project and in your home folder, and any variable that moves the second;
- where it reads skills, agents and plugins inside those folders, and in what format;
- any other agent's folder it also reads, such as the shared `.agents` folder;
- the program it installs on your `PATH`, which tells aireg it is installed.

Leave out anything the documentation doesn't say. A guessed folder installs artifacts the agent never loads.

## 2. Write the file

Save this as `tool.json`, with your agent's names and folders in place of `tool`:

```json
{
  "$schema": "https://raw.githubusercontent.com/atlanai/ai-registry/main/cli/schema/harness.schema.json",
  "id": "tool",
  "displayName": "Tool",
  "roots": { "project": ".tool", "user": { "default": "~/.tool", "env": "TOOL_HOME" } },
  "detect": { "binary": ["tool"] },
  "reads": { "skill": ["agents"] },
  "kinds": {
    "plugin": { "shape": "contents" },
    "agent": { "shape": "file", "subdir": "agents", "extension": ".md" }
  }
}
```

This one reads skills from the shared `.agents` folder, so aireg places a skill there once for every agent that reads it, and links each agent into `.tool/agents/`. It loads no plugins of its own, so a plugin lands as the skills and agents it holds.

## 3. Check it, then save it

```bash
aireg harnesses check tool.json
mkdir -p ~/.aireg/harnesses
cp tool.json ~/.aireg/harnesses/tool.json
aireg harnesses show tool
```

`check` names anything aireg would refuse. `show` prints the harness as aireg resolved it, with every default filled in.

## 4. Install into it

```bash
aireg add <registry>/<namespace> --for tool
```

Run [`aireg status`](status.md) to see what landed, and [`aireg remove`](remove.md) to take it out again, with any config edit the file made.

## Replace a built-in harness

A file whose `id` is a built-in harness's, with `"overrides": true`, replaces it. Run `aireg harnesses show <id>` first and start from what it prints.

## See also

[`aireg harnesses`](harnesses.md), [Harnesses](options.md#harnesses), [CLI reference](index.md)
