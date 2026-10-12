import type { Choice } from "./multiselect.ts";

// The picker's outline: groups hold sections or leaves, sections hold leaves.
// A run of choices sharing a group (or a section within it) becomes one heading.

interface Leaf<T> {
  kind: "leaf";
  choice: Choice<T>;
  /** 0 at the top level, 1 under a group, 2 under a section. */
  depth: number;
  last: boolean;
  parent: Heading<T> | undefined;
}

interface Heading<T> {
  kind: "group" | "section";
  key: string;
  label: string;
  group: string;
  /** What picking the whole group answers with, when it stands for something. */
  value: T | undefined;
  leaves: Choice<T>[];
  children: Node<T>[];
  parent: Heading<T> | undefined;
}

export type Node<T> = Leaf<T> | Heading<T>;

export type Fill = "none" | "some" | "all";

function heading<T>(
  kind: Heading<T>["kind"],
  key: string,
  label: string,
  parent: Heading<T> | undefined,
  value?: T,
): Heading<T> {
  const group = parent?.label ?? label;
  return { kind, key, label, group, value, leaves: [], children: [], parent };
}

function adopt<T>(parent: Heading<T> | undefined, choice: Choice<T>, depth: number): Leaf<T> {
  const leaf: Leaf<T> = { kind: "leaf", choice, depth, last: false, parent };
  parent?.children.push(leaf);
  return leaf;
}

export function plant<T>(
  choices: readonly Choice<T>[],
  grouped: boolean,
  values?: ReadonlyMap<string, T>,
): Node<T>[] {
  const top: Node<T>[] = [];
  for (const choice of choices) {
    if (!grouped || choice.group === undefined) {
      top.push(adopt(undefined, choice, 0));
      continue;
    }
    let group = top.at(-1);
    if (group?.kind !== "group" || group.label !== choice.group) {
      group = heading(
        "group",
        `g${top.length}`,
        choice.group,
        undefined,
        values?.get(choice.group),
      );
      top.push(group);
    }
    group.leaves.push(choice);
    if (choice.section === undefined) {
      adopt(group, choice, 1);
      continue;
    }
    let section = group.children.at(-1);
    if (section?.kind !== "section" || section.label !== choice.section) {
      section = heading("section", `${group.key}/${group.children.length}`, choice.section, group);
      group.children.push(section);
    }
    section.leaves.push(choice);
    adopt(section, choice, 2);
  }
  for (const node of outline(top)) {
    const last = node.kind === "leaf" ? undefined : node.children.at(-1);
    if (last?.kind === "leaf") last.last = true;
  }
  return top;
}

/** Every node in display order; headings in `folded` hide what they hold. */
export function outline<T>(top: readonly Node<T>[], folded?: ReadonlySet<string>): Node<T>[] {
  const out: Node<T>[] = [];
  const walk = (nodes: readonly Node<T>[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.kind !== "leaf" && folded?.has(node.key) !== true) walk(node.children);
    }
  };
  walk(top);
  return out;
}

function groupOf<T>(node: Node<T>): Heading<T> | undefined {
  let at = node.kind === "group" ? node : node.parent;
  while (at !== undefined && at.kind !== "group") at = at.parent;
  return at;
}

/**
 * What is picked: leaf values, plus group values that stand for a whole group.
 * Insertion order is the answer's order, as the caller sees it.
 */
export class Selection<T> {
  readonly picked: Set<T>;
  private readonly top: readonly Node<T>[];

  constructor(top: readonly Node<T>[], initial: readonly T[]) {
    this.top = top;
    this.picked = new Set(initial);
  }

  /** Whether the group this node sits in is picked as a whole. */
  private whole(node: Node<T>): boolean {
    const group = groupOf(node);
    return group?.value !== undefined && this.picked.has(group.value);
  }

  /** A section reads its own leaves only; a group picked whole is full. */
  fill(node: Node<T>): Fill {
    if (this.whole(node)) return "all";
    if (node.kind === "leaf") return this.picked.has(node.choice.value) ? "all" : "none";
    const taken = node.leaves.filter((choice) => this.picked.has(choice.value)).length;
    return taken === 0 ? "none" : taken === node.leaves.length ? "all" : "some";
  }

  /** Leaves picked on their own or through their group. */
  covered(): number {
    return outline(this.top).filter(
      (node) => node.kind === "leaf" && (this.picked.has(node.choice.value) || this.whole(node)),
    ).length;
  }

  toggle(node: Node<T>): void {
    const group = groupOf(node);
    if (node.kind === "group" && node.value !== undefined) {
      if (this.picked.has(node.value)) this.picked.delete(node.value);
      else this.take(node);
      return;
    }
    // Leaving part of a whole group out picks the rest by name, so what it adds later stays out.
    if (group?.value !== undefined && this.whole(node)) {
      this.picked.delete(group.value);
      const left = node.kind === "leaf" ? [node.choice] : node.leaves;
      for (const choice of group.leaves) if (!left.includes(choice)) this.picked.add(choice.value);
      return;
    }
    if (node.kind === "leaf") {
      const value = node.choice.value;
      if (this.picked.has(value)) this.picked.delete(value);
      else this.picked.add(value);
      return;
    }
    if (this.fill(node) === "all") this.drop(node);
    else {
      if (group?.value !== undefined) this.picked.delete(group.value);
      for (const choice of node.leaves) this.picked.add(choice.value);
    }
  }

  /** Every top-level row, or nothing once every one is already full. */
  toggleAll(): void {
    const full = this.top.every((node) => this.fill(node) === "all");
    for (const node of this.top) {
      if (full) this.drop(node);
      else this.take(node);
    }
  }

  private take(node: Node<T>): void {
    if (node.kind === "leaf") this.picked.add(node.choice.value);
    else if (node.kind === "group" && node.value !== undefined) {
      // Named once in the manifest, so the leaves it covers go.
      this.picked.add(node.value);
      for (const choice of node.leaves) this.picked.delete(choice.value);
    } else for (const choice of node.leaves) this.picked.add(choice.value);
  }

  private drop(node: Node<T>): void {
    if (node.kind === "leaf") {
      this.picked.delete(node.choice.value);
      return;
    }
    if (node.value !== undefined) this.picked.delete(node.value);
    for (const choice of node.leaves) this.picked.delete(choice.value);
  }

  /** Labels of what was picked: leaves in display order, then whole groups. */
  labels(): string[] {
    const nodes = outline(this.top);
    const leaves = nodes.flatMap((node) =>
      node.kind === "leaf" && this.picked.has(node.choice.value) ? [node.choice.label] : [],
    );
    const groups = nodes.flatMap((node) =>
      node.kind === "group" && node.value !== undefined && this.picked.has(node.value)
        ? [node.label]
        : [],
    );
    return [...leaves, ...new Set(groups)];
  }
}
