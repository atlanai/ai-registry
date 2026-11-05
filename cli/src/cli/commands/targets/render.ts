import type { DetectionRule } from "#core/target/detect.ts";

export function foundBy(by: DetectionRule | undefined): string {
  switch (by) {
    case "env":
      return "from its environment variables";
    case "binary":
      return "on your PATH";
    case "project":
      return "in this project";
    case "user":
      return "in your home folder";
    case undefined:
      return "on this machine";
  }
}
